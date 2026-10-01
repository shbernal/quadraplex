import { loadConfig, ttlMs } from '../../../core/config.ts'
import { compactNumber, span } from '../../../core/format.ts'
import type { Ecosystem, Target } from '../../../core/types.ts'
import type { IssueDetail } from '../../../sources/github.ts'
import { buildProjects, projectItems, type Project } from '../../model.ts'

/**
 * The sigil ledger files every project once per domain it lives in. A project with a repo,
 * two npm packages and a Firefox listing is three rows in three panes, each row carrying
 * only the numbers that domain publishes. Words are replaced by a fixed alphabet: every
 * row opens with a three-slot strip (health, movement, attention) drawn from SIGILS.
 */

export type PaneId = 'github' | 'registries' | 'extensions'
export type Health = 'ok' | 'partial' | 'blind' | 'stale' | 'error'
export type Move = 'up' | 'down' | 'held' | 'new' | 'none'
export type Flag = 'waiting' | 'drift' | 'unreleased' | 'bots' | 'none'
export type Tone = 'up' | 'down' | 'muted' | 'warn' | 'plain'

/** The whole alphabet. Each slot reads one question, so a column of strips scans as one. */
export const SIGILS = {
  health: {
    ok: ['●', 'fresh'],
    partial: ['◕', 'partial'],
    blind: ['○', 'unknown'],
    stale: ['◌', 'stale'],
    error: ['✕', 'fetch failed'],
  },
  move: {
    up: ['▲', 'rose'],
    down: ['▼', 'fell'],
    held: ['═', 'held'],
    new: ['✶', 'new'],
    none: [' ', ''],
  },
  flag: {
    waiting: ['', 'someone waits'],
    drift: ['≠', 'stores disagree'],
    unreleased: ['↥', 'unreleased push'],
    bots: ['⊛', 'bot PRs'],
    none: [' ', ''],
  },
} as const satisfies Record<string, Record<string, readonly [string, string]>>

export const ICON = {
  github: '',
  repo: '',
  star: '',
  fork: '',
  issue: '',
  pr: '',
  push: '',
  npm: '',
  pypi: '',
  download: '',
  month: '',
  tag: '',
  rocket: '',
  package: '',
  plug: '',
  chrome: '',
  firefox: '',
  people: '',
  rating: '',
  hourglass: '\uf4e3',
  clock: '',
  person: '',
} as const

export type Cell = { text: string; tone?: Tone; delta?: number | null }

export type Column = {
  id: string
  icon: string
  label: string
  /** Lower survives longer when the pane is too narrow to draw every column. */
  priority: number
  /** Whether the column carries a signed delta beside its value. */
  delta?: boolean
}

export type Row = {
  project: Project
  name: string
  health: Health
  move: Move
  flag: Flag
  cells: Record<string, Cell>
  /** This domain's targets only, which is what the detail view lists. */
  targets: Target[]
  items: IssueDetail[]
}

export type Badge = { icon: string; text: string; delta?: number | null; tone?: Tone }

export type Pane = {
  id: PaneId
  title: string
  icon: string
  ecosystems: Ecosystem[]
  columns: Column[]
  rows: Row[]
  badges: Badge[]
  /** Oldest fetch behind the pane, the age the whole pane can claim. */
  asOf: string | null
  stale: number
}

export type Board = { now: number; panes: Pane[]; baselineAt: string | null }

const BOT = /\[bot\]$|^dependabot|^renovate/i

/**
 * `lastPush` moves for any branch. A push in the same minutes a bot opened or updated a PR
 * is that bot's branch, not work waiting on main, so it does not earn the unreleased mark.
 */
function unreleased(project: Project, items: IssueDetail[]): boolean {
  const u = project.drift.unreleased
  if (!u) return false
  const at = Date.parse(u.pushedAt)
  return !items.some(
    (i) =>
      BOT.test(i.author) &&
      [i.createdAt, i.updatedAt].some((t) => Math.abs(Date.parse(t) - at) < 120_000),
  )
}

type Sum = { value: number; delta: number | null } | null

/** A delta only when every contributing target has one, same rule as the main dashboard. */
function sum(targets: Target[], key: string): Sum {
  const relevant = targets.filter((t) => typeof t.metrics[key] === 'number')
  if (relevant.length === 0) return null
  const deltas = relevant.map((t) => (t.deltas ? (t.deltas[key] ?? null) : null))
  return {
    value: relevant.reduce((acc, t) => acc + (t.metrics[key] as number), 0),
    delta: deltas.includes(null) ? null : deltas.reduce((acc, d) => acc! + d!, 0),
  }
}

function total(rows: Sum[]): Sum {
  const known = rows.filter((r): r is NonNullable<Sum> => r !== null)
  if (known.length === 0) return null
  return {
    value: known.reduce((t, r) => t + r.value, 0),
    delta: known.some((r) => r.delta === null)
      ? null
      : known.reduce((t, r) => t + (r.delta ?? 0), 0),
  }
}

function newest(targets: Target[], key: string): string | null {
  return (
    targets
      .map((t) => t.metrics[key])
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .toSorted()
      .at(-1) ?? null
  )
}

function moveOf(s: Sum): Move {
  if (!s) return 'none'
  if (s.delta === null) return 'new'
  return s.delta > 0 ? 'up' : s.delta < 0 ? 'down' : 'held'
}

function num(s: Sum): Cell {
  return s ? { text: compactNumber(s.value), delta: s.delta } : { text: '·', tone: 'muted' }
}

function age(iso: string | null, now: number): Cell {
  return iso ? { text: span(iso, new Date(now).toISOString()) } : { text: '·', tone: 'muted' }
}

/** The version a domain agrees on, or a count of how many it publishes at once. */
function version(targets: Target[]): Cell {
  const all = new Set(
    targets.map((t) => t.metrics.version).filter((v): v is string => typeof v === 'string'),
  )
  if (all.size === 0) return { text: '·', tone: 'muted' }
  if (all.size === 1) return { text: [...all][0]! }
  return { text: `⋯${all.size}`, tone: 'muted' }
}

function health(targets: Target[], now: number, unknown: (t: Target) => boolean): Health {
  const config = loadConfig()
  if (targets.some((t) => t.errors?.length)) return 'error'
  if (targets.some((t) => t.stale || now - Date.parse(t.fetchedAt) > ttlMs(config, t.ecosystem)))
    return 'stale'
  const blind = targets.filter(unknown).length
  if (blind === targets.length) return 'blind'
  return blind ? 'partial' : 'ok'
}

/**
 * Someone waiting and stores disagreeing are defects and lead. An unreleased push and a bot
 * PR are common enough that ranking on them would bury what moved, so they only mark.
 */
const FLAG_RANK: Record<Flag, number> = { waiting: 0, drift: 1, unreleased: 2, bots: 2, none: 2 }
const MOVE_RANK: Record<Move, number> = { up: 0, down: 1, new: 2, held: 3, none: 4 }

function order(rows: Row[], headline: (r: Row) => number): Row[] {
  return rows.toSorted(
    (a, b) =>
      FLAG_RANK[a.flag] - FLAG_RANK[b.flag] ||
      MOVE_RANK[a.move] - MOVE_RANK[b.move] ||
      headline(b) - headline(a) ||
      a.name.localeCompare(b.name),
  )
}

function freshness(targets: Target[], now: number) {
  const config = loadConfig()
  const asOf = targets.reduce<string | null>(
    (old, t) => (old === null || t.fetchedAt < old ? t.fetchedAt : old),
    null,
  )
  const stale = targets.filter(
    (t) => t.stale || now - Date.parse(t.fetchedAt) > ttlMs(config, t.ecosystem),
  ).length
  return { asOf, stale }
}

const of = (p: Project, ecos: Ecosystem[]) => p.targets.filter((t) => ecos.includes(t.ecosystem))

// ---------------------------------------------------------------- GitHub

function github(projects: Project[], account: string | undefined, now: number): Pane {
  const ecosystems: Ecosystem[] = ['github']
  const sums = { stars: [] as Sum[], prs: [] as Sum[], issues: [] as Sum[] }
  let waiting = 0
  const rows = projects
    .filter((p) => of(p, ecosystems).length)
    .map((project): Row => {
      const targets = of(project, ecosystems)
      const items = projectItems(project)
      const people = items.filter((i) => !BOT.test(i.author) && i.author !== account)
      const bots = items.filter((i) => BOT.test(i.author))
      const stars = sum(targets, 'stars')
      // The issue/PR split needs a second request per repo. Without it only the combined
      // count is known, which goes in the issue column and marks the row partial.
      const split = targets.every((t) => typeof t.metrics.openIssues === 'number')
      const issues = split ? sum(targets, 'openIssues') : sum(targets, 'openIssuesAndPRs')
      const prs = split ? sum(targets, 'openPRs') : null
      sums.stars.push(stars)
      sums.issues.push(issues)
      sums.prs.push(prs)
      if (people.length) waiting++
      const flag: Flag = people.length
        ? 'waiting'
        : unreleased(project, items)
          ? 'unreleased'
          : bots.length
            ? 'bots'
            : 'none'
      return {
        project,
        name: project.name,
        health: health(targets, now, (t) => typeof t.metrics.openIssues !== 'number'),
        move: moveOf(stars),
        flag,
        targets,
        items,
        cells: {
          stars: num(stars),
          forks: num(sum(targets, 'forks')),
          issues: split || !issues ? num(issues) : { text: `${issues.value}?`, tone: 'muted' },
          prs: prs ? num(prs) : { text: '?', tone: 'muted' },
          push: age(newest(targets, 'lastPush'), now),
        },
      }
    })
  const stars = total(sums.stars)
  const all = rows.flatMap((r) => r.targets)
  return {
    id: 'github',
    title: 'GitHub',
    icon: ICON.github,
    ecosystems,
    columns: [
      { id: 'stars', icon: ICON.star, label: 'stars', priority: 0, delta: true },
      { id: 'issues', icon: ICON.issue, label: 'issues', priority: 1 },
      { id: 'prs', icon: ICON.pr, label: 'PRs', priority: 1 },
      { id: 'push', icon: ICON.push, label: 'last push', priority: 2 },
      { id: 'forks', icon: ICON.fork, label: 'forks', priority: 3 },
    ],
    rows: order(rows, (r) => sum(r.targets, 'stars')?.value ?? -1),
    badges: [
      { icon: ICON.repo, text: String(rows.length) },
      { icon: ICON.star, text: stars ? compactNumber(stars.value) : '·', delta: stars?.delta },
      { icon: ICON.pr, text: String(total(sums.prs)?.value ?? 0) },
      { icon: ICON.issue, text: String(total(sums.issues)?.value ?? 0) },
      ...(waiting
        ? [{ icon: SIGILS.flag.waiting[0], text: String(waiting), tone: 'warn' as const }]
        : []),
    ],
    ...freshness(all, now),
  }
}

// ---------------------------------------------------------------- npm + PyPI

/**
 * PyPI holds one package against npm's twenty-odd, which is not enough to earn a pane. The
 * two registries publish the same three readings, so they share columns and the row's
 * store column says which one a project ships to.
 */
function registries(projects: Project[], now: number): Pane {
  const ecosystems: Ecosystem[] = ['npm', 'pypi']
  const weeks: Sum[] = []
  const rows = projects
    .filter((p) => of(p, ecosystems).length)
    .map((project): Row => {
      const targets = of(project, ecosystems)
      const week = sum(targets, 'downloadsWeek')
      weeks.push(week)
      const stores = (['npm', 'pypi'] as const)
        .filter((e) => targets.some((t) => t.ecosystem === e))
        .map((e) => ICON[e])
        .join('')
      return {
        project,
        name: project.name,
        health: health(targets, now, (t) => typeof t.metrics.downloadsWeek !== 'number'),
        move: moveOf(week),
        flag: project.drift.versions
          ? 'drift'
          : unreleased(project, projectItems(project))
            ? 'unreleased'
            : 'none',
        targets,
        items: [],
        cells: {
          store: { text: targets.length > 1 ? `${stores}×${targets.length}` : stores },
          week: num(week),
          month: num(sum(targets, 'downloadsMonth')),
          version: version(targets),
          published: age(newest(targets, 'lastPublish'), now),
        },
      }
    })
  const all = rows.flatMap((r) => r.targets)
  const week = total(weeks)
  return {
    id: 'registries',
    title: 'npm · PyPI',
    icon: ICON.package,
    ecosystems,
    columns: [
      { id: 'store', icon: ICON.package, label: 'store', priority: 2 },
      { id: 'week', icon: ICON.download, label: 'downloads/wk', priority: 0, delta: true },
      { id: 'version', icon: ICON.tag, label: 'version', priority: 1 },
      { id: 'published', icon: ICON.rocket, label: 'published', priority: 1 },
      { id: 'month', icon: ICON.month, label: 'downloads/mo', priority: 3, delta: true },
    ],
    rows: order(rows, (r) => sum(r.targets, 'downloadsWeek')?.value ?? -1),
    badges: [
      { icon: ICON.npm, text: String(all.filter((t) => t.ecosystem === 'npm').length) },
      { icon: ICON.pypi, text: String(all.filter((t) => t.ecosystem === 'pypi').length) },
      { icon: ICON.download, text: week ? compactNumber(week.value) : '·', delta: week?.delta },
    ],
    ...freshness(all, now),
  }
}

// ---------------------------------------------------------------- CWS + AMO

/**
 * A Chrome install bucket and a Firefox daily-user count do not share a unit, so they get
 * a column each and are never summed. Google prints no badge under a threshold, which is
 * unknown rather than zero, and reads as the blind sigil.
 */
function extensions(projects: Project[], now: number): Pane {
  const ecosystems: Ecosystem[] = ['cws', 'amo']
  const firefox: Sum[] = []
  const rows = projects
    .filter((p) => of(p, ecosystems).length)
    .map((project): Row => {
      const targets = of(project, ecosystems)
      const chrome = targets.find((t) => t.ecosystem === 'cws')
      const amo = targets.filter((t) => t.ecosystem === 'amo')
      const ff = sum(amo, 'users')
      firefox.push(ff)
      const rating = project.rating
      return {
        project,
        name: project.name,
        health: health(
          targets,
          now,
          (t) => typeof t.metrics.users !== 'number' && typeof t.metrics.users !== 'string',
        ),
        move: moveOf(ff),
        flag: project.drift.versions
          ? 'drift'
          : unreleased(project, projectItems(project))
            ? 'unreleased'
            : 'none',
        targets,
        items: [],
        cells: {
          chrome: !chrome
            ? { text: ' ' }
            : typeof chrome.metrics.users === 'string'
              ? { text: chrome.metrics.users }
              : { text: SIGILS.health.blind[0], tone: 'muted' },
          firefox: amo.length ? num(ff) : { text: ' ' },
          rating: rating
            ? { text: `${rating.score.toFixed(1)}·${rating.count}` }
            : { text: '·', tone: 'muted' },
          version: version(targets),
          published: age(newest(targets, 'lastPublish'), now),
        },
      }
    })
  const all = rows.flatMap((r) => r.targets)
  const users = total(firefox)
  return {
    id: 'extensions',
    title: 'Chrome · Firefox',
    icon: ICON.plug,
    ecosystems,
    columns: [
      { id: 'chrome', icon: ICON.chrome, label: 'Chrome users', priority: 0 },
      { id: 'firefox', icon: ICON.firefox, label: 'Firefox users', priority: 0, delta: true },
      { id: 'rating', icon: ICON.rating, label: 'rating·count', priority: 2 },
      { id: 'version', icon: ICON.tag, label: 'version', priority: 1 },
      { id: 'published', icon: ICON.rocket, label: 'published', priority: 1 },
    ],
    rows: order(
      rows,
      (r) =>
        sum(
          r.targets.filter((t) => t.ecosystem === 'amo'),
          'users',
        )?.value ?? -1,
    ),
    badges: [
      { icon: ICON.chrome, text: String(all.filter((t) => t.ecosystem === 'cws').length) },
      { icon: ICON.firefox, text: String(all.filter((t) => t.ecosystem === 'amo').length) },
      { icon: ICON.people, text: users ? compactNumber(users.value) : '·', delta: users?.delta },
    ],
    ...freshness(all, now),
  }
}

/** The baseline most deltas share, so the bar can say "since Sep 29" once. */
function commonBaseline(projects: Project[]): string | null {
  const counts = new Map<string, number>()
  for (const t of projects.flatMap((p) => p.targets)) {
    if (t.deltaBaselineAt)
      counts.set(
        t.deltaBaselineAt.slice(0, 10),
        (counts.get(t.deltaBaselineAt.slice(0, 10)) ?? 0) + 1,
      )
  }
  const top = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]
  return top ? top[0] : null
}

export function buildBoard(now = Date.now()): Board {
  const projects = buildProjects()
  const account = loadConfig().accounts.github
  return {
    now,
    panes: [github(projects, account, now), registries(projects, now), extensions(projects, now)],
    baselineAt: commonBaseline(projects),
  }
}
