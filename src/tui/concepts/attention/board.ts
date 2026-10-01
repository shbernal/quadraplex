import { loadConfig, ttlMs } from '../../../core/config.ts'
import { compactNumber, formatDate, formatDelta, span } from '../../../core/format.ts'
import { ECOSYSTEMS, type Ecosystem, type Target } from '../../../core/types.ts'
import type { IssueDetail } from '../../../sources/github.ts'
import { awaitingCurves, buildProjects, projectItems, type Project } from '../../model.ts'

/**
 * The attention board files readings, not projects. A project lands in every lane whose
 * question it answers yes to, and a lane that answers no for everyone is still drawn,
 * as a check that passed, because "nothing drifted" is a reading too.
 */

export type Tone = 'warn' | 'up' | 'down' | 'muted' | 'plain'

export type Card = {
  /** Usually one project, several when the reading is about a group, like a sweep. */
  projects: Project[]
  title: string
  reading: string
  /** A short qualifier at the right edge: an age, a classification. */
  tag: string
  tone: Tone
  /** Noise the board can explain but should not lead with. Drawn dim, sorted last. */
  demoted: boolean
  evidence: string[]
  /** Daily values behind a movement, drawn as a trace beside the reading. */
  trace?: number[]
  /** Signed relative size of a movement, for ordering rises before falls, big first. */
  size?: number
}

export type LaneId = 'waiting' | 'drift' | 'unreleased' | 'movement' | 'blind'

export type Lane = {
  id: LaneId
  title: string
  /** The stores this lane's reading is built from, so it can inherit their freshness. */
  sources: Ecosystem[]
  /** Oldest fetch among the targets that fed this lane, the age the whole lane can claim. */
  asOf: string | null
  /** The stores behind this lane that are past their TTL. */
  stale: Ecosystem[]
  cards: Card[]
  /** What an empty lane says instead of nothing. */
  passed: string
}

export type SourceFreshness = {
  ecosystem: Ecosystem
  targets: number
  oldest: string
  ttl: number
  stale: number
}

export type Board = {
  now: number
  lanes: Lane[]
  freshness: SourceFreshness[]
  /** The single baseline most deltas were measured against, when they share one day. */
  baselineAt: string | null
  /** Projects no lane claimed. Reported by name so silence is visibly a reading. */
  quiet: Project[]
  /** What `r` would run: only the stale stores, never a blanket refetch it does not need. */
  refreshArgs: string[] | null
}

const BOT = /\[bot\]$|^dependabot|^renovate/i
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const ago = (iso: string, now: number) => span(iso, new Date(now).toISOString())

function oldestFetch(targets: Target[]): string | null {
  return targets.reduce<string | null>(
    (old, t) => (old === null || t.fetchedAt < old ? t.fetchedAt : old),
    null,
  )
}

function laneFreshness(projects: Project[], sources: Ecosystem[]) {
  const fed = projects.flatMap((p) => p.targets).filter((t) => sources.includes(t.ecosystem))
  const stale = ECOSYSTEMS.filter((e) => fed.some((t) => t.ecosystem === e && t.stale))
  return { asOf: oldestFetch(fed), stale }
}

// ---------------------------------------------------------------- waiting on you

/**
 * Who is waiting decides the order. A stranger's issue or PR is a person waiting on the
 * maintainer; a bot PR is a chore; an issue the maintainer filed is a note to self.
 */
function waiting(projects: Project[], account: string | undefined, now: number): Card[] {
  const cards: Card[] = []
  for (const project of projects) {
    const items = projectItems(project)
    if (items.length === 0) continue
    const people = items.filter((i) => !BOT.test(i.author) && i.author !== account)
    const bots = items.filter((i) => BOT.test(i.author))
    const mine = items.filter((i) => i.author === account)
    const oldest = items.reduce((a, b) => (a.createdAt < b.createdAt ? a : b))
    const parts: string[] = []
    if (people.length) parts.push(`${people.length} from people`)
    if (bots.length) parts.push(`${bots.length} bot ${bots.length === 1 ? 'PR' : 'PRs'}`)
    if (mine.length) parts.push(`${mine.length} your own`)
    cards.push({
      projects: [project],
      title: project.name,
      reading: parts.join(', '),
      tag: `oldest ${ago(oldest.createdAt, now)}`,
      tone: people.length ? 'warn' : 'plain',
      demoted: people.length === 0,
      evidence: items.map((i) => itemLine(i, now)),
    })
  }
  const weight = (c: Card) => (c.tone === 'warn' ? 0 : c.reading.includes('bot') ? 1 : 2)
  return cards.toSorted((a, b) => weight(a) - weight(b) || a.title.localeCompare(b.title))
}

function itemLine(item: IssueDetail, now: number): string {
  const kind = item.kind === 'pr' ? 'PR' : 'issue'
  return `#${item.number} ${kind} by ${item.author}, ${ago(item.createdAt, now)} old: ${item.title}`
}

// ---------------------------------------------------------------- store drift

function storeDrift(projects: Project[]): Card[] {
  return projects
    .filter((p) => p.drift.versions)
    .map((project) => ({
      projects: [project],
      title: project.name,
      reading: project.drift.versions!.map((v) => `${v.ecosystem} ${v.version}`).join(' vs '),
      tag: 'review queue?',
      tone: 'warn' as const,
      demoted: false,
      evidence: project.drift.versions!.map((v) => `${v.ecosystem} publishes ${v.version}`),
    }))
}

// ---------------------------------------------------------------- unreleased work

/**
 * `lastPush` is GitHub's pushed_at, which moves for any branch. A push within a couple of
 * minutes of a bot opening a PR is that bot's branch, not work on the default branch, so
 * it is explained and demoted instead of reported as unreleased.
 */
function botBranch(project: Project, pushedAt: string): IssueDetail | undefined {
  const at = Date.parse(pushedAt)
  return projectItems(project).find(
    (i) =>
      BOT.test(i.author) &&
      [i.createdAt, i.updatedAt].some((t) => Math.abs(Date.parse(t) - at) < 2 * MINUTE),
  )
}

/** Three or more repos pushed inside one hour is one sweep across the portfolio. */
function sweeps<T extends { project: Project; pushedAt: string }>(entries: T[]): T[][] {
  const sorted = entries.toSorted((a, b) => a.pushedAt.localeCompare(b.pushedAt))
  const clusters: T[][] = []
  for (const entry of sorted) {
    const last = clusters.at(-1)
    if (last && Date.parse(entry.pushedAt) - Date.parse(last[0]!.pushedAt) <= HOUR) {
      last.push(entry)
    } else clusters.push([entry])
  }
  return clusters.filter((c) => c.length >= 3)
}

function unreleased(projects: Project[], now: number): Card[] {
  const genuine: { project: Project; pushedAt: string; publishedAt: string }[] = []
  const bots: { project: Project; item: IssueDetail; pushedAt: string }[] = []
  for (const project of projects) {
    const u = project.drift.unreleased
    if (!u) continue
    const item = botBranch(project, u.pushedAt)
    if (item) bots.push({ project, item, pushedAt: u.pushedAt })
    else genuine.push({ project, ...u })
  }

  const swept = sweeps(genuine)
  const inSweep = new Set(swept.flat().map((e) => e.project.key))
  const cards: Card[] = genuine
    .filter((e) => !inSweep.has(e.project.key))
    .toSorted((a, b) => b.pushedAt.localeCompare(a.pushedAt))
    .map(({ project, pushedAt, publishedAt }) => ({
      projects: [project],
      title: project.name,
      reading: `pushed ${span(publishedAt, pushedAt)} after ${project.drift.version ?? 'its release'}`,
      tag: `${ago(pushedAt, now)} ago`,
      tone: 'warn' as const,
      demoted: false,
      evidence: [
        `last release ${formatDate(publishedAt)} (${project.drift.version ?? 'version unknown'})`,
        `last push ${formatDate(pushedAt)}, ${span(publishedAt, pushedAt)} later`,
      ],
    }))

  for (const cluster of swept) {
    const first = cluster[0]!.pushedAt
    cards.push({
      projects: cluster.map((e) => e.project),
      title: `${cluster.length} repos, one sweep`,
      reading: cluster.map((e) => e.project.name).join(', '),
      tag: formatDate(first),
      tone: 'plain',
      demoted: false,
      evidence: [
        `${cluster.length} repos were pushed within an hour of ${formatDate(first)}.`,
        'Likely one change applied everywhere. Release it everywhere or nowhere.',
        ...cluster.map(
          (e) =>
            `${e.project.name}: ${e.project.drift.version ?? '?'} from ${formatDate(e.publishedAt)}`,
        ),
      ],
    })
  }
  if (bots.length) {
    cards.push({
      projects: bots.map((b) => b.project),
      title: `${bots.length} bot branches`,
      reading: bots.map((b) => b.project.name).join(', '),
      tag: 'not main',
      tone: 'muted',
      demoted: true,
      evidence: [
        'pushed_at moves for any branch. Each of these pushes landed the same minute a',
        "bot opened a PR, so it is that bot's branch, not unreleased work on main.",
        ...bots.map(
          (b) =>
            `${b.project.name}: ${b.item.author} #${b.item.number}, ${ago(b.pushedAt, now)} ago`,
        ),
      ],
    })
  }
  return cards
}

// ---------------------------------------------------------------- movement

/**
 * A delta is news when it is large against the number it moved. Ten downloads on a
 * package doing ten a week is a doubling; on one doing a thousand it is weather.
 */
function notable(value: number, delta: number): boolean {
  const before = value - delta
  return Math.abs(delta) >= 10 && Math.abs(delta) / Math.max(before, 1) >= 0.2
}

function movement(projects: Project[]): Card[] {
  const cards: Card[] = []
  for (const project of projects) {
    const d = project.downloads
    if (d && d.delta !== null && notable(d.value, d.delta)) {
      const before = Math.max(d.value - d.delta, 1)
      // Past a doubling a ratio reads faster than a percentage.
      const ratio =
        d.value >= before * 2
          ? `×${(d.value / before).toFixed(1)}`
          : `${d.delta > 0 ? '+' : ''}${Math.round((d.delta / before) * 100)}%`
      cards.push({
        projects: [project],
        title: project.name,
        reading: `${compactNumber(d.value)}/wk ${formatDelta(d.delta)} ${ratio}`,
        tag: 'downloads',
        tone: d.delta > 0 ? 'up' : 'down',
        demoted: false,
        size: d.delta / Math.max(d.value - d.delta, 1),
        trace: project.series.slice(-28).map((point) => point.downloads),
        evidence: [
          `weekly downloads ${d.value - d.delta} -> ${d.value}${d.baselineAt ? ` since ${formatDate(d.baselineAt)}` : ''}`,
        ],
      })
    }
    const s = project.stars
    if (s && s.delta) {
      cards.push({
        projects: [project],
        title: project.name,
        reading: `${s.value} stars ${formatDelta(s.delta)}`,
        tag: 'stars',
        tone: s.delta > 0 ? 'up' : 'down',
        demoted: false,
        size: s.delta,
        evidence: [`stars ${s.value - s.delta} -> ${s.value}`],
      })
    }
    const r = project.reach
    const users = project.targets.find((t) => t.ecosystem === r?.source)?.metrics.users
    if (
      r &&
      r.delta &&
      typeof users === 'number' &&
      Math.abs(r.delta) / Math.max(users - r.delta, 1) >= 0.2
    ) {
      cards.push({
        projects: [project],
        title: project.name,
        reading: `${r.label} users ${formatDelta(r.delta)}`,
        tag: r.source,
        tone: r.delta > 0 ? 'up' : 'down',
        demoted: false,
        size: r.delta / 10,
        evidence: [`${r.source} daily users moved ${formatDelta(r.delta)}`],
      })
    }
  }
  return cards.toSorted(
    (a, b) => Number(b.size! > 0) - Number(a.size! > 0) || Math.abs(b.size!) - Math.abs(a.size!),
  )
}

// ---------------------------------------------------------------- blind spots

/** What the store cannot tell you, said once per cause rather than once per metric. */
function blind(projects: Project[]): Card[] {
  const cards: Card[] = []
  for (const project of projects) {
    const errors = project.targets.flatMap((t) => (t.errors ?? []).map((e) => `${t.id}: ${e}`))
    if (errors.length) {
      cards.push({
        projects: [project],
        title: project.name,
        reading: `last fetch failed, showing older values`,
        tag: 'error',
        tone: 'warn',
        demoted: false,
        evidence: errors,
      })
    }
    const fresh = project.targets.filter((t) => t.deltas === null)
    if (fresh.length) {
      cards.push({
        projects: [project],
        title: project.name,
        reading: 'new, no baseline yet',
        tag: 'new',
        tone: 'muted',
        demoted: false,
        evidence: fresh.map((t) => `${t.id} has no snapshot a full window old`),
      })
    }
    if (!project.targets.some((t) => t.ecosystem === 'github') && project.targets.length) {
      cards.push({
        projects: [project],
        title: project.name,
        reading: 'no linked repo, unreleased work cannot be read',
        tag: 'unlinked',
        tone: 'muted',
        demoted: true,
        evidence: [
          'A store listing with no repository link. Add one under "links" in config.json.',
        ],
      })
    }
  }
  const unbadged = projects.filter((p) =>
    p.targets.some((t) => t.ecosystem === 'cws' && t.metrics.users === null && !t.errors?.length),
  )
  if (unbadged.length) {
    cards.push({
      projects: unbadged,
      title: `${unbadged.length} Chrome listings`,
      reading: 'under the user-count threshold, so users read unknown',
      tag: 'cws',
      tone: 'muted',
      demoted: true,
      evidence: [
        'Google prints no user badge below a threshold. Absent is unknown, not zero.',
        ...unbadged.map((p) => p.name),
      ],
    })
  }
  const curveless = projects.filter(awaitingCurves)
  if (curveless.length) {
    cards.push({
      projects: curveless,
      title: `${curveless.length} starred repos`,
      reading: 'no star curve, so no stargazer names',
      tag: '--curves',
      tone: 'muted',
      demoted: true,
      evidence: [
        'Curves are built only by "qplex refresh --curves".',
        ...curveless.map((p) => p.name),
      ],
    })
  }
  return cards.toSorted((a, b) => Number(a.demoted) - Number(b.demoted))
}

// ---------------------------------------------------------------- the board

function freshness(projects: Project[], now: number): SourceFreshness[] {
  const config = loadConfig()
  const targets = projects.flatMap((p) => p.targets)
  return ECOSYSTEMS.flatMap((ecosystem) => {
    const mine = targets.filter((t) => t.ecosystem === ecosystem)
    const oldest = oldestFetch(mine)
    if (!oldest) return []
    return [
      {
        ecosystem,
        targets: mine.length,
        oldest,
        ttl: ttlMs(config, ecosystem),
        stale: mine.filter(
          (t) => t.stale || now - Date.parse(t.fetchedAt) > ttlMs(config, ecosystem),
        ).length,
      },
    ]
  })
}

/** The baseline most numeric deltas share, so the board can say "since Sep 29" once. */
function commonBaseline(projects: Project[]): string | null {
  const counts = new Map<string, number>()
  for (const t of projects.flatMap((p) => p.targets)) {
    if (!t.deltaBaselineAt) continue
    const day = t.deltaBaselineAt.slice(0, 13)
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  const top = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]
  if (!top) return null
  return (
    projects
      .flatMap((p) => p.targets)
      .map((t) => t.deltaBaselineAt)
      .find((b) => b?.startsWith(top[0])) ?? null
  )
}

export function buildBoard(now = Date.now()): Board {
  const projects = buildProjects()
  const account = loadConfig().accounts.github

  const spec: [LaneId, string, Ecosystem[], Card[], string][] = [
    [
      'waiting',
      'Waiting on you',
      ['github'],
      waiting(projects, account, now),
      'No open issues or PRs',
    ],
    [
      'drift',
      'Store drift',
      ['npm', 'pypi', 'amo', 'cws'],
      storeDrift(projects),
      `All ${
        projects.filter(
          (p) =>
            p.targets
              .filter((t) => t.ecosystem !== 'github')
              .map((t) => t.ecosystem)
              .filter((e, i, a) => a.indexOf(e) === i).length > 1,
        ).length
      } multi-store projects publish one version`,
    ],
    [
      'unreleased',
      'Unreleased',
      ['github', 'npm', 'pypi', 'amo', 'cws'],
      unreleased(projects, now),
      'Every pushed repo has released since',
    ],
    ['movement', 'Moved', [...ECOSYSTEMS], movement(projects), 'Nothing moved more than 20%'],
    ['blind', 'Blind spots', [...ECOSYSTEMS], blind(projects), 'Every reading has a baseline'],
  ]

  const lanes: Lane[] = spec.map(([id, title, sources, cards, passed]) => ({
    id,
    title,
    sources,
    cards,
    passed,
    ...laneFreshness(cards.length ? cards.flatMap((c) => c.projects) : projects, sources),
  }))

  const claimed = new Set(
    lanes.flatMap((l) =>
      l.cards.filter((c) => !c.demoted).flatMap((c) => c.projects.map((p) => p.key)),
    ),
  )
  const fresh = freshness(projects, now)
  const staleSources = fresh.filter((f) => f.stale > 0).map((f) => f.ecosystem)
  return {
    now,
    lanes,
    freshness: fresh,
    baselineAt: commonBaseline(projects),
    quiet: projects
      .filter((p) => !claimed.has(p.key))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    refreshArgs:
      staleSources.length === 0
        ? null
        : staleSources.length === fresh.length
          ? ['refresh']
          : staleSources.length === 1
            ? ['refresh', '--only', staleSources[0]!]
            : ['refresh'],
  }
}
