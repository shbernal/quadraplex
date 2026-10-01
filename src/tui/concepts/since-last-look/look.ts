/**
 * "What happened since I last looked", derived from the append-only log and nothing
 * else. Every reading compares two moments on the store's own timeline, the anchor
 * refresh and the newest one, so the window is always one a refresh actually observed.
 */
import { hidden, loadConfig, ttlMs, type Config } from '../../../core/config.ts'
import { computeDrift } from '../../../core/drift.ts'
import { compactNumber as compact, formatDate } from '../../../core/format.ts'
import { readSnapshots, groupById } from '../../../core/store.ts'
import type { Ecosystem, SeriesPoint, Snapshot } from '../../../core/types.ts'
import { buildProjects, projectItems, projectStargazers, type Project } from '../../model.ts'

/** One refresh run. Snapshots of one run land within minutes of each other. */
export type Epoch = { at: string; targets: number }

const EPOCH_GAP_MS = 20 * 60_000
const DAY_MS = 86_400_000

export function epochsOf(snapshots: Snapshot[]): Epoch[] {
  const times = snapshots.map((s) => Date.parse(s.fetchedAt)).toSorted((a, b) => a - b)
  const out: { at: number; targets: number }[] = []
  for (const t of times) {
    const last = out.at(-1)
    if (last && t - last.at <= EPOCH_GAP_MS) {
      last.at = t
      last.targets++
    } else out.push({ at: t, targets: 1 })
  }
  return out.map((e) => ({ at: new Date(e.at).toISOString(), targets: e.targets }))
}

export type EventKind =
  | 'downloads'
  | 'stars'
  | 'forks'
  | 'users'
  | 'rating'
  | 'release'
  | 'issue'
  | 'pr'
  | 'joined'
  | 'drift'
  | 'unreleased'

export type LookEvent = {
  kind: EventKind
  /** When it happened, as precisely as the store knows. A day string when only a day. */
  at: string
  /** True when `at` is only the refresh that first saw it, not when it happened. */
  seenOnly: boolean
  text: string
  sign: 1 | -1 | 0
  score: number
  /** A longer line the story has room for and the list does not. */
  detail?: string
  /** Why this was set aside instead of counted, when it was. */
  noise?: string
}

/** Downloads are a flow: counted per day inside the window and judged against habit. */
export type Flow = {
  days: SeriesPoint[]
  observed: number
  expected: number
  usualPerDay: number
  /** Last day any registry has counted. Days after it are unknown, not zero. */
  horizon: string
  /** False while the package is too young for its median to mean anything. */
  habit: boolean
}

export type Movement = {
  project: Project
  events: LookEvent[]
  noise: LookEvent[]
  score: number
  flow: Flow | null
  /** Every target was first seen after the anchor, so nothing here has a baseline. */
  fresh: boolean
  firstSeen: string
}

export type Freshness = { ecosystem: Ecosystem; fetchedAt: string; stale: boolean }

export type Look = {
  epochs: Epoch[]
  anchorIndex: number
  anchor: Epoch
  latest: Epoch
  moved: Movement[]
  minor: Movement[]
  cooling: Movement[]
  fresh: Movement[]
  quiet: Movement[]
  noise: LookEvent[]
  retired: string[]
  standing: { versions: Project[]; unreleased: Project[] }
  freshness: Freshness[]
  horizon: string | null
  errors: number
  projects: Project[]
  byProject: Map<string, Movement>
}

/** The newest value a target had known by `t`, skipping the nulls a failed field leaves. */
function knownAt(history: Snapshot[], key: string, t: number) {
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i]!
    if (Date.parse(s.fetchedAt) > t) continue
    const value = s.metrics[key]
    if (value !== null && value !== undefined) return { value, at: s.fetchedAt }
  }
  return null
}

/** A stock moved: the score is relative, so +1 on 2 outranks +3 on 500. */
function stockScore(before: number, after: number, weight: number): number {
  return weight * Math.abs(Math.log2((after + 1) / (before + 1)))
}

const STORE: Record<Ecosystem, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  github: 'GitHub',
  amo: 'Firefox',
  cws: 'Chrome',
}

export function storeName(ecosystem: Ecosystem): string {
  return STORE[ecosystem]
}

function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

const USUAL_DAYS = 28
/** Days of history a package needs before it has a habit to compare against. */
const HABIT_DAYS = 14
/** Loudest days left out of the habit, about one release burst. */
const TRIMMED = 3

/**
 * Observed against what the project's own previous four weeks predict for the same span.
 * A day past the registry's horizon is left out entirely rather than counted as zero.
 */
function flowOf(series: SeriesPoint[], anchorAt: string): Flow | null {
  if (series.length === 0) return null
  const start = dayOf(anchorAt)
  const horizon = series.at(-1)!.date
  const days = series.filter((p) => p.date > start)
  const before = series.filter((p) => p.date <= start).slice(-USUAL_DAYS)
  // A mean with the loudest days dropped: a release spike inside the four weeks would
  // otherwise make every ordinary day after it read as a slump, and a plain median of a
  // package downloaded every third day is zero.
  const sorted = before.map((p) => p.downloads).toSorted((a, b) => a - b)
  const kept = sorted.slice(0, Math.max(sorted.length - TRIMMED, 1))
  const usualPerDay = sorted.length ? kept.reduce((t, v) => t + v, 0) / kept.length : 0
  const observed = days.reduce((total, p) => total + p.downloads, 0)
  // A package first downloaded inside those four weeks has no habit to break, and a
  // ratio against its pre-launch zeros would read as a thousandfold surge.
  const firstActive = series.find((p) => p.downloads > 0)?.date
  const settled =
    before.length >= HABIT_DAYS &&
    Boolean(firstActive) &&
    firstActive! <= before.at(-HABIT_DAYS)!.date
  return {
    days,
    observed,
    expected: usualPerDay * days.length,
    usualPerDay,
    horizon,
    habit: settled || observed === 0,
  }
}

function flowEvent(flow: Flow): LookEvent | null {
  if (flow.days.length === 0) return null
  const { observed, expected } = flow
  if (!flow.habit) {
    return {
      kind: 'downloads',
      at: flow.days.at(-1)!.date,
      seenOnly: false,
      text: `${observed} dl, too young for a habit`,
      sign: 1,
      score: observed >= 10 ? 2 : 0,
      ...(observed >= 10 ? {} : { noise: 'within habit' }),
    }
  }
  const excess = observed - expected
  const z = excess / Math.sqrt(expected + 1)
  const ratio = (observed + 1) / (expected + 1)
  // A fall needs more evidence than a rise: two quiet days on a small package are a
  // weekend, and a slump is rarely what someone opening this wants to see first.
  const loud = excess > 0 ? z >= 2 && excess >= 5 : z <= -3 && expected >= 20 && ratio < 0.5
  const usual = `usual ~${expected < 10 ? Math.round(expected) : compact(Math.round(expected))}`
  const multiple =
    ratio >= 2 && expected >= 2
      ? `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}x usual`
      : usual
  return {
    kind: 'downloads',
    at: flow.days.at(-1)!.date,
    seenOnly: false,
    text: `${observed} dl, ${excess > 0 ? multiple : usual}`,
    sign: excess > 0 ? 1 : -1,
    score: loud ? Math.min((excess > 0 ? 4 : 0.6) * Math.abs(Math.log2(ratio)), 16) : 0,
    ...(loud ? {} : { noise: 'within habit' }),
  }
}

/** Robots open most pull requests on a small portfolio, so they are counted, not ranked. */
function isBot(author: string): boolean {
  return author.endsWith('[bot]')
}

function compare(
  project: Project,
  byId: Map<string, Snapshot[]>,
  anchor: number,
  config: Config,
): Movement {
  const events: LookEvent[] = []
  const noise: LookEvent[] = []
  const push = (event: LookEvent) => (event.noise ? noise : events).push(event)
  const histories = project.targets.map((t) => ({ target: t, history: byId.get(t.id) ?? [] }))
  const joined = histories.filter(({ history }) => Date.parse(history[0]!.fetchedAt) > anchor)
  const fresh = joined.length === histories.length

  if (!fresh) {
    for (const { target, history } of joined) {
      push({
        kind: 'joined',
        at: history[0]!.fetchedAt,
        seenOnly: true,
        text: `now on ${storeName(target.ecosystem)}`,
        sign: 1,
        score: 2,
      })
    }
  }

  const releases = new Map<string, { stores: Ecosystem[]; at: string }>()
  for (const { target, history } of histories) {
    if (Date.parse(history[0]!.fetchedAt) > anchor) continue
    const stock = (key: string, weight: number, unit: string, kind: EventKind) => {
      const then = knownAt(history, key, anchor)
      const now = knownAt(history, key, Infinity)
      if (!then || !now || Date.parse(now.at) <= anchor) return
      if (typeof then.value !== 'number' || typeof now.value !== 'number') {
        // Chrome publishes a bucket label that comes and goes below a threshold. Its
        // movement measures the badge, so it is set aside rather than ranked.
        if (then.value !== now.value && key === 'users') {
          noise.push({
            kind,
            at: now.at,
            seenOnly: true,
            text: `Chrome badge ${then.value} -> ${now.value}`,
            sign: 0,
            score: 0,
            noise: 'bucket label',
          })
        }
        return
      }
      const delta = now.value - then.value
      if (delta === 0) return
      const plural = Math.abs(delta) === 1 ? unit : `${unit}s`
      push({
        kind,
        at: now.at,
        seenOnly: true,
        text: `${delta > 0 ? '+' : '-'}${Math.abs(delta)} ${plural} -> ${now.value}`,
        sign: delta > 0 ? 1 : -1,
        score: stockScore(then.value, now.value, weight),
      })
    }
    if (target.ecosystem === 'github') {
      stock('stars', 8, 'star', 'stars')
      stock('forks', 5, 'fork', 'forks')
    }
    if (target.ecosystem === 'amo') stock('users', 6, 'user', 'users')
    if (target.ecosystem === 'cws') stock('users', 0, 'user', 'users')
    if (target.ecosystem === 'amo' || target.ecosystem === 'cws') {
      const then = knownAt(history, 'rating', anchor)
      const now = knownAt(history, 'rating', Infinity)
      if (now && Date.parse(now.at) > anchor && then?.value !== now.value) {
        push({
          kind: 'rating',
          at: now.at,
          seenOnly: true,
          text: `rated ${now.value} on ${storeName(target.ecosystem)}`,
          sign: 0,
          score: 2,
        })
      }
    }
    if (target.ecosystem !== 'github') {
      const then = knownAt(history, 'version', anchor)
      const now = knownAt(history, 'version', Infinity)
      if (then && now && then.value !== now.value) {
        const version = String(now.value)
        const published = target.metrics.lastPublish
        const entry = releases.get(version) ?? {
          stores: [],
          at: typeof published === 'string' ? published : now.at,
        }
        if (!entry.stores.includes(target.ecosystem)) entry.stores.push(target.ecosystem)
        releases.set(version, entry)
      }
    }
  }
  for (const [version, { stores, at }] of releases) {
    // A monorepo releases several packages to one store at once: one event, not five.
    const where = stores.every((s) => s === 'npm') ? '' : ` on ${stores.map(storeName).join(' + ')}`
    push({
      kind: 'release',
      at,
      seenOnly: false,
      text: `released ${version}${where}`,
      sign: 1,
      score: 3,
    })
  }

  const stargazers = projectStargazers(project)
  for (const person of stargazers?.people ?? []) {
    if (Date.parse(person.starredAt) <= anchor) continue
    // The curve knows who and when, which turns "seen by a refresh" into a dated event.
    const star = events.find((e) => e.kind === 'stars')
    if (!star) continue
    star.text += ` @${person.login}`
    star.at = person.starredAt
    star.seenOnly = false
  }

  const self = config.accounts.github
  for (const item of projectItems(project)) {
    if (Date.parse(item.createdAt) <= anchor) continue
    const label = `${item.kind === 'pr' ? 'PR' : 'issue'} #${item.number}`
    if (isBot(item.author)) {
      noise.push({
        kind: item.kind,
        at: item.createdAt,
        seenOnly: false,
        text: `${label} by ${item.author.replace('[bot]', '')}`,
        sign: 0,
        score: 0,
        noise: 'bot',
      })
      continue
    }
    const mine = item.author === self
    push({
      kind: item.kind,
      at: item.createdAt,
      seenOnly: false,
      text: `${label} ${mine ? 'by you' : `by @${item.author}`}`,
      detail: item.title,
      sign: 0,
      score: mine ? 0.3 : 4,
    })
  }

  // Drift is a standing condition. Only drift that began inside the window is news.
  const now = project.drift
  if (!fresh) {
    const thenTargets = histories
      .map(({ history }) => history.filter((s) => Date.parse(s.fetchedAt) <= anchor).at(-1))
      .filter((s): s is Snapshot => s !== undefined)
      .map((s) => ({ ...s, deltas: null, stale: false }))
    const then = computeDrift(thenTargets)
    if (now.versions && !then.versions) {
      push({
        kind: 'drift',
        at: project.targets
          .map((t) => t.fetchedAt)
          .toSorted()
          .at(-1)!,
        seenOnly: true,
        text: `stores split: ${now.versions.map((v) => `${storeName(v.ecosystem)} ${v.version}`).join(', ')}`,
        sign: -1,
        score: 2.5,
      })
    }
    if (now.unreleased && Date.parse(now.unreleased.pushedAt) > anchor) {
      push({
        kind: 'unreleased',
        at: now.unreleased.pushedAt,
        seenOnly: false,
        text: `pushed, unreleased since ${formatDate(now.unreleased.publishedAt)}`,
        sign: 0,
        score: 0.8,
      })
    }
  }

  const flow = fresh ? null : flowOf(project.series, new Date(anchor).toISOString())
  const downloads = flow ? flowEvent(flow) : null
  if (downloads) push(downloads)

  events.sort((a, b) => b.score - a.score)
  const [top, ...rest] = events
  const score = top ? top.score + 0.25 * rest.reduce((total, e) => total + e.score, 0) : 0
  const firstSeen = histories.map(({ history }) => history[0]!.fetchedAt).toSorted()[0]!
  return { project, events, noise, score, flow, fresh, firstSeen }
}

const byScore = (a: Movement, b: Movement) => b.score - a.score
const byName = (a: Movement, b: Movement) => a.project.name.localeCompare(b.project.name)

export type LookOptions = { anchorAt?: number; anchorIndex?: number; now?: number }

/** The newest epoch at or before a moment, so an anchor is always a refresh that happened. */
export function epochIndexAt(epochs: Epoch[], t: number): number {
  let index = 0
  epochs.forEach((e, i) => {
    if (Date.parse(e.at) <= t) index = i
  })
  return Math.min(index, Math.max(epochs.length - 2, 0))
}

/** Everything a look reads, loaded once so moving the anchor is a recomputation, not a read. */
export type Timeline = {
  config: Config
  byId: Map<string, Snapshot[]>
  epochs: Epoch[]
  projects: Project[]
}

export function loadTimeline(): Timeline {
  const snapshots = readSnapshots()
  return {
    config: loadConfig(),
    byId: groupById(snapshots),
    epochs: epochsOf(snapshots),
    projects: buildProjects(),
  }
}

/** With no last look on record, a few days back is the question most people are asking. */
export const DEFAULT_LOOKBACK_MS = 3 * DAY_MS

export function buildLook(timeline: Timeline, options: LookOptions = {}): Look {
  const { config, byId, epochs } = timeline
  const now = options.now ?? Date.now()
  const anchorIndex =
    options.anchorIndex ??
    epochIndexAt(epochs, options.anchorAt ?? Date.parse(epochs.at(-1)!.at) - DEFAULT_LOOKBACK_MS)
  const anchor = epochs[anchorIndex]!
  const latest = epochs.at(-1)!
  const anchorMs = Date.parse(anchor.at)

  const movements = timeline.projects.map((p) => compare(p, byId, anchorMs, config))
  const moved = movements.filter((m) => !m.fresh && m.score >= 1)
  const small = movements.filter((m) => !m.fresh && m.score > 0 && m.score < 1)
  // Below habit is a reading, not an event, so it gets a line of its own under the news.
  const cooling = small.filter((m) => m.events[0]?.kind === 'downloads' && m.events[0].sign < 0)
  const minor = small.filter((m) => !cooling.includes(m))
  const fresh = movements.filter((m) => m.fresh)
  const quiet = movements.filter((m) => !m.fresh && m.score === 0)

  // Retired inside the window: visible at the anchor, hidden now. Kept out of every list
  // by the store's own rules, so this line is the only place a retirement is told.
  const retired: string[] = []
  for (const history of byId.values()) {
    const then = history.filter((s) => Date.parse(s.fetchedAt) <= anchorMs).at(-1)
    const last = history.at(-1)!
    if (then && !hidden(config, then) && hidden(config, last))
      retired.push(last.name.split('/').at(-1)!)
  }

  const projects = movements.map((m) => m.project)
  const freshness = new Map<Ecosystem, Freshness>()
  for (const target of projects.flatMap((p) => p.targets)) {
    const seen = freshness.get(target.ecosystem)
    if (!seen || target.fetchedAt > seen.fetchedAt) {
      freshness.set(target.ecosystem, {
        ecosystem: target.ecosystem,
        fetchedAt: target.fetchedAt,
        stale: now - Date.parse(target.fetchedAt) > ttlMs(config, target.ecosystem),
      })
    }
  }
  const horizons = movements.map((m) => m.flow?.horizon).filter((h): h is string => Boolean(h))

  return {
    epochs,
    anchorIndex,
    anchor,
    latest,
    moved: moved.toSorted(byScore),
    minor: minor.toSorted(byScore),
    cooling: cooling.toSorted(byScore),
    fresh: fresh.toSorted(byName),
    quiet: quiet.toSorted(byName),
    noise: movements.flatMap((m) => m.noise.filter((e) => e.noise !== 'within habit')),
    retired: retired.toSorted(),
    standing: {
      versions: projects.filter((p) => p.drift.versions),
      unreleased: projects.filter((p) => p.drift.unreleased),
    },
    freshness: [...freshness.values()],
    horizon: horizons.length ? horizons.toSorted()[0]! : null,
    errors: projects.flatMap((p) => p.targets).filter((t) => t.errors?.length).length,
    projects,
    byProject: new Map(movements.map((m) => [m.project.key, m])),
  }
}

const GLYPH: Record<LookEvent['kind'], string> = {
  downloads: '',
  stars: '★',
  forks: '',
  users: '',
  rating: '',
  release: '◆',
  issue: '',
  pr: '',
  joined: '+',
  drift: '≠',
  unreleased: '^',
}

export function eventText(event: LookEvent): string {
  const glyph = GLYPH[event.kind]
  return glyph ? `${glyph} ${event.text}` : event.text
}
