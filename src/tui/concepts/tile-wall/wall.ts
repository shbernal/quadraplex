import { loadConfig } from '../../../core/config.ts'
import { compactNumber, span } from '../../../core/format.ts'
import type { Ecosystem, Target } from '../../../core/types.ts'
import { buildProjects, projectItems, type Project } from '../../model.ts'

/**
 * The tile wall files every project once per domain it lives in. A project with a repo, a
 * package and two store listings is three tiles, each carrying only the numbers that
 * domain publishes, so no tile has a blank cell and no pane mixes units.
 */

/** Nerd Font glyphs, all in the BMP private use area so each is one cell wide. */
export const G = {
  github: '',
  npm: '',
  pypi: '',
  stores: '',
  chrome: '',
  firefox: '',
  star: '',
  pr: '',
  issue: '',
  fork: '',
  download: '',
  package: '',
  tag: '',
  clock: '',
  commit: '',
  users: '',
  rating: '',
  bolt: '',
  up: '',
  down: '',
  sparkle: '',
  hourglass: '',
  error: '',
  archive: '',
  link: '',
  refresh: '',
  check: '',
} as const

export const ECOSYSTEM_GLYPH: Record<Ecosystem, string> = {
  github: G.github,
  npm: G.npm,
  pypi: G.pypi,
  amo: G.firefox,
  cws: G.chrome,
}

export type Tone = 'attention' | 'up' | 'down' | 'new' | 'muted' | 'plain'
export type Seg = { text: string; tone?: Tone }
/** One icon and its value, kept together so a narrow tile drops whole badges, not halves. */
export type Badge = Seg[]

/** Border colour. Freshness is carried by the line style instead, so the two never fight. */
export type State = 'attention' | 'up' | 'down' | 'new' | 'quiet'

export type Tile = {
  project: Project
  /** Only this pane's targets: a GitHub tile never reads a download count. */
  targets: Target[]
  name: string
  /** Glyphs before the name, for a pane that spans more than one store. */
  marks: Seg[]
  state: State
  stale: boolean
  body: Badge[]
  foot: Badge[]
  /** Why the border has its colour, said in words on the detail view. */
  reasons: string[]
  /** Relative size of the headline move, for ordering within a state. */
  size: number
  /** Open PRs and issues, GitHub only. Null where the split is unknown. */
  open?: { prs: number | null; issues: number | null }
}

export type PaneId = 'github' | 'registries' | 'stores'

export type Pane = {
  id: PaneId
  title: string
  icons: string[]
  ecosystems: Ecosystem[]
  tiles: Tile[]
  totals: Badge[]
  /** Oldest fetch behind the pane, the age every tile in it can claim. */
  asOf: string | null
  stale: boolean
}

export type Freshness = { ecosystem: Ecosystem; oldest: string; stale: boolean }

export type Wall = {
  now: number
  panes: Pane[]
  freshness: Freshness[]
  baselineAt: string | null
  empty: boolean
}

const BOT = /\[bot\]$|^dependabot|^renovate/i

type Total = { value: number; delta: number | null }

/** A delta is only known when every contributing target has one. */
function total(targets: Target[], key: string): Total | null {
  const relevant = targets.filter((t) => typeof t.metrics[key] === 'number')
  if (relevant.length === 0) return null
  const deltas = relevant.map((t) => (t.deltas ? (t.deltas[key] ?? null) : null))
  return {
    value: relevant.reduce((sum, t) => sum + (t.metrics[key] as number), 0),
    delta: deltas.includes(null) ? null : deltas.reduce((sum, d) => sum! + d!, 0),
  }
}

/** Ten downloads on a package doing ten a week is a doubling; on one doing a thousand it is weather. */
function notable(t: Total | null, floor: number): boolean {
  if (!t || t.delta === null || t.delta === 0) return false
  const before = Math.max(t.value - t.delta, 1)
  return Math.abs(t.delta) >= floor && Math.abs(t.delta) / before >= 0.2
}

function relative(t: Total | null): number {
  if (!t || !t.delta) return 0
  return t.delta / Math.max(t.value - t.delta, 1)
}

/** Unknown reads "new", never zero. A zero delta prints nothing: the tile is quiet. */
export function deltaSeg(delta: number | null | undefined): Seg[] {
  if (delta === null || delta === undefined) return [{ text: ' new', tone: 'new' }]
  if (delta === 0) return []
  return [
    {
      text: `${delta > 0 ? '↑' : '↓'}${compactNumber(Math.abs(delta))}`,
      tone: delta > 0 ? 'up' : 'down',
    },
  ]
}

function count(icon: string, value: number | null | undefined, hot: Tone = 'plain'): Badge {
  if (value === null || value === undefined) return [{ text: `${icon} ?`, tone: 'muted' }]
  if (value === 0) return [{ text: `${icon} ·`, tone: 'muted' }]
  return [{ text: `${icon} ${compactNumber(value)}`, tone: hot }]
}

function moved(t: Total | null, icon: string): Badge {
  if (!t) return [{ text: `${icon} ?`, tone: 'muted' }]
  return [{ text: `${icon} ${compactNumber(t.value)}`, tone: 'plain' }, ...deltaSeg(t.delta)]
}

function age(iso: string | undefined, now: number): string {
  return iso ? span(iso, new Date(now).toISOString()) : '?'
}

function newest(targets: Target[], key: string): string | undefined {
  return targets
    .map((t) => t.metrics[key])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .toSorted()
    .at(-1)
}

function errors(targets: Target[]): string[] {
  return targets.flatMap((t) => (t.errors ?? []).map((e) => `${t.id}: ${e}`))
}

function settle(
  reasons: string[],
  headline: Total | null,
  floor: number,
): { state: State; size: number } {
  if (reasons.length) return { state: 'attention', size: 0 }
  if (headline && headline.delta === null) return { state: 'new', size: 0 }
  if (notable(headline, floor)) {
    return { state: headline!.delta! > 0 ? 'up' : 'down', size: relative(headline) }
  }
  return { state: 'quiet', size: 0 }
}

// ---------------------------------------------------------------- GitHub

/**
 * Any open PR asks for a decision, and so does an issue somebody else filed. An issue the
 * maintainer filed is a note to self: counted on the badge, never lighting the border.
 */
function githubTile(
  project: Project,
  targets: Target[],
  account: string | undefined,
  now: number,
): Tile {
  const stars = total(targets, 'stars')
  const both = total(targets, 'openIssuesAndPRs')?.value ?? null
  const items = projectItems(project)
  // The split costs a token. Without one, the items refresh wrote to disk still tell PRs
  // from issues when they account for every open one; otherwise the split stays unknown.
  const listed = both !== null && items.length === both
  const prs =
    total(targets, 'openPRs')?.value ??
    (listed ? items.filter((i) => i.kind === 'pr').length : null)
  const issues =
    total(targets, 'openIssues')?.value ??
    (listed ? items.filter((i) => i.kind !== 'pr').length : null)
  const others = items.filter((i) => i.kind !== 'pr' && i.author !== account)
  const reasons: string[] = []
  if (prs) reasons.push(`${prs} open pull request${prs === 1 ? '' : 's'}`)
  if (prs === null && both) reasons.push(`${both} open issues and PRs, split unknown`)
  if (others.length) {
    const bots = others.filter((i) => BOT.test(i.author)).length
    reasons.push(
      `${others.length} issue${others.length === 1 ? '' : 's'} from others${bots ? `, ${bots} bots` : ''}`,
    )
  }
  reasons.push(...errors(targets))
  const { state, size } = settle(reasons, stars, 1)

  const body: Badge[] = [
    moved(stars, G.star),
    ...(prs !== null && issues !== null
      ? [count(G.pr, prs, 'attention'), count(G.issue, issues)]
      : [count(`${G.issue}${G.pr}`, both)]),
  ]

  const pushed = newest(targets, 'lastPush')
  const unreleased = project.drift.unreleased
  const forks = total(targets, 'forks')?.value ?? 0
  const foot: Badge[] = [
    unreleased
      ? [{ text: `${G.commit} ${age(pushed, now)}`, tone: 'attention' }]
      : [{ text: `${G.clock} ${age(pushed, now)}`, tone: 'muted' }],
  ]
  if (forks) foot.push([{ text: `${G.fork} ${forks}`, tone: 'muted' }])
  if (targets.some((t) => t.metrics.archived === 'yes'))
    foot.push([{ text: G.archive, tone: 'muted' }])

  return {
    project,
    targets,
    name: project.name,
    marks: [],
    state,
    stale: targets.some((t) => t.stale),
    body,
    foot,
    reasons: unreleased
      ? [
          ...reasons,
          `pushed ${span(unreleased.publishedAt, unreleased.pushedAt)} after the last release`,
        ]
      : reasons,
    size,
    open: { prs, issues },
  }
}

// ---------------------------------------------------------------- registries

function versionFoot(targets: Target[], now: number): Badge[] {
  const versions = [
    ...new Set(targets.map((t) => t.metrics.version).filter((v) => typeof v === 'string')),
  ]
  const latest = targets.toSorted((a, b) =>
    String(b.metrics.lastPublish ?? '').localeCompare(String(a.metrics.lastPublish ?? '')),
  )[0]
  const version = versions.length === 1 ? versions[0] : latest?.metrics.version
  return [
    [{ text: `${G.tag} ${typeof version === 'string' ? version : '?'}`, tone: 'muted' }],
    [{ text: `${G.clock} ${age(newest(targets, 'lastPublish'), now)}`, tone: 'muted' }],
  ]
}

/** Two stores of one project on different versions: one review queue was never followed up. */
function drifted(targets: Target[]): { ecosystem: Ecosystem; version: string }[] | null {
  const per = new Map<Ecosystem, Set<string>>()
  for (const t of targets) {
    if (typeof t.metrics.version !== 'string') continue
    const set = per.get(t.ecosystem) ?? new Set()
    set.add(t.metrics.version)
    per.set(t.ecosystem, set)
  }
  const single = [...per.entries()].filter(([, set]) => set.size === 1)
  const versions = single.map(([ecosystem, set]) => ({ ecosystem, version: [...set][0]! }))
  return new Set(versions.map((v) => v.version)).size > 1 ? versions : null
}

function registryTile(project: Project, targets: Target[], now: number): Tile {
  const downloads = total(targets, 'downloadsWeek')
  const drift = drifted(targets)
  const reasons = [
    ...(drift
      ? [`registries disagree: ${drift.map((d) => `${d.ecosystem} ${d.version}`).join(' vs ')}`]
      : []),
    ...errors(targets),
  ]
  const { state, size } = settle(reasons, downloads, 10)
  const ecosystems = new Set(targets.map((t) => t.ecosystem))
  const body: Badge[] = [moved(downloads, G.download)]
  if (targets.length > 1) body.push([{ text: `${G.package} ${targets.length}`, tone: 'muted' }])
  if (targets.some((t) => t.metrics.deprecated === 'yes'))
    body.push([{ text: G.archive, tone: 'muted' }])
  return {
    project,
    targets,
    name: project.name,
    marks: [
      ...(ecosystems.has('npm') ? [{ text: G.npm, tone: 'down' as const }] : []),
      ...(ecosystems.has('pypi') ? [{ text: G.pypi, tone: 'new' as const }] : []),
    ],
    state,
    stale: targets.some((t) => t.stale),
    body,
    foot: versionFoot(targets, now),
    reasons,
    size,
  }
}

// ---------------------------------------------------------------- extension stores

/**
 * Chrome publishes a bucket label and nothing below a threshold, so its badge shows the
 * label verbatim or "?", never a number to subtract. Firefox users are a real count.
 */
function storeTile(project: Project, targets: Target[], now: number): Tile {
  const cws = targets.filter((t) => t.ecosystem === 'cws')
  const amo = targets.filter((t) => t.ecosystem === 'amo')
  const users = total(amo, 'users')
  const drift = drifted(targets)
  const reasons = [
    ...(drift
      ? [`stores disagree: ${drift.map((d) => `${d.ecosystem} ${d.version}`).join(' vs ')}`]
      : []),
    ...errors(targets),
  ]
  const { state, size } = settle(reasons, amo.length ? users : null, 3)
  const body: Badge[] = []
  if (cws.length) {
    const label = cws.map((t) => t.metrics.users).find((u) => typeof u === 'string')
    body.push(
      label ? [{ text: `${G.chrome} ${label}` }] : [{ text: `${G.chrome} ?`, tone: 'muted' }],
    )
  }
  if (amo.length) body.push(moved(users, G.firefox))

  // A listing's rating outlives its release date as news, so it takes the age's place.
  const [version, published] = versionFoot(targets, now) as [Badge, Badge]
  const foot: Badge[] = [
    drift ? [{ text: `≠ ${drift.map((d) => d.version).join('/')}`, tone: 'attention' }] : version,
    project.rating ? [{ text: `${G.rating} ${project.rating.score.toFixed(1)}` }] : published,
  ]
  return {
    project,
    targets,
    name: project.name,
    marks: [],
    state,
    stale: targets.some((t) => t.stale),
    body,
    foot,
    reasons,
    size,
  }
}

// ---------------------------------------------------------------- the wall

const RANK: Record<State, number> = { attention: 0, up: 1, down: 1, new: 2, quiet: 3 }

/** Hot tiles top left, so the wall reads in the order it asks for attention. */
function order(tiles: Tile[], headline: (t: Tile) => number): Tile[] {
  return tiles.toSorted(
    (a, b) =>
      RANK[a.state] - RANK[b.state] ||
      Math.abs(b.size) - Math.abs(a.size) ||
      headline(b) - headline(a) ||
      a.name.localeCompare(b.name),
  )
}

function oldest(targets: Target[]): string | null {
  return targets.reduce<string | null>(
    (o, t) => (o === null || t.fetchedAt < o ? t.fetchedAt : o),
    null,
  )
}

function pane(
  id: PaneId,
  title: string,
  icons: string[],
  ecosystems: Ecosystem[],
  tiles: Tile[],
  totals: Badge[],
): Pane {
  const targets = tiles.flatMap((t) => t.targets)
  return {
    id,
    title,
    icons,
    ecosystems,
    tiles,
    totals,
    asOf: oldest(targets),
    stale: targets.some((t) => t.stale),
  }
}

function commonBaseline(targets: Target[]): string | null {
  const counts = new Map<string, number>()
  for (const t of targets) {
    if (!t.deltaBaselineAt) continue
    const day = t.deltaBaselineAt.slice(0, 10)
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  const top = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]
  return top
    ? (targets.find((t) => t.deltaBaselineAt?.startsWith(top[0]))?.deltaBaselineAt ?? null)
    : null
}

const value = (t: Total | null) => t?.value ?? -1

const of = (p: Project, ecosystems: Ecosystem[]) =>
  p.targets.filter((t) => ecosystems.includes(t.ecosystem))

export function buildWall(now = Date.now()): Wall {
  const projects = buildProjects()
  const account = loadConfig().accounts.github

  const github = projects
    .filter((p) => of(p, ['github']).length)
    .map((p) => githubTile(p, of(p, ['github']), account, now))
  const registries = projects
    .filter((p) => of(p, ['npm', 'pypi']).length)
    .map((p) => registryTile(p, of(p, ['npm', 'pypi']), now))
  const stores = projects
    .filter((p) => of(p, ['cws', 'amo']).length)
    .map((p) => storeTile(p, of(p, ['cws', 'amo']), now))

  const all = projects.flatMap((p) => p.targets)
  const repos = all.filter((t) => t.ecosystem === 'github')
  const packages = all.filter((t) => t.ecosystem === 'npm' || t.ecosystem === 'pypi')
  const listings = all.filter((t) => t.ecosystem === 'cws' || t.ecosystem === 'amo')
  const sumOpen = (key: 'prs' | 'issues') => {
    const values = github.map((t) => t.open?.[key] ?? null)
    return values.includes(null) ? null : values.reduce((a, b) => a! + b!, 0)
  }

  const panes = [
    pane(
      'github',
      'GitHub',
      [G.github],
      ['github'],
      order(github, (t) => value(total(t.targets, 'stars'))),
      [
        moved(total(repos, 'stars'), G.star),
        count(G.pr, sumOpen('prs'), 'attention'),
        count(G.issue, sumOpen('issues')),
      ],
    ),
    pane(
      'registries',
      'npm · PyPI',
      [G.npm, G.pypi],
      ['npm', 'pypi'],
      order(registries, (t) => value(total(t.targets, 'downloadsWeek'))),
      [
        [...moved(total(packages, 'downloadsWeek'), G.download), { text: '/wk', tone: 'muted' }],
        [{ text: `${G.package} ${packages.length}`, tone: 'muted' }],
      ],
    ),
    pane(
      'stores',
      'CWS · AMO',
      [G.chrome, G.firefox],
      ['cws', 'amo'],
      order(stores, (t) =>
        value(
          total(
            t.targets.filter((x) => x.ecosystem === 'amo'),
            'users',
          ),
        ),
      ),
      [
        [
          {
            text: `${G.chrome} ${listings.filter((t) => t.ecosystem === 'cws').length}`,
            tone: 'muted',
          },
        ],
        [
          {
            text: `${G.firefox} ${listings.filter((t) => t.ecosystem === 'amo').length}`,
            tone: 'muted',
          },
        ],
        moved(
          total(
            listings.filter((t) => t.ecosystem === 'amo'),
            'users',
          ),
          G.users,
        ),
      ],
    ),
  ].filter((p) => p.tiles.length > 0)

  const ecosystems = [...new Set(all.map((t) => t.ecosystem))]
  return {
    now,
    panes,
    freshness: ecosystems.map((ecosystem) => {
      const mine = all.filter((t) => t.ecosystem === ecosystem)
      return { ecosystem, oldest: oldest(mine)!, stale: mine.some((t) => t.stale) }
    }),
    baselineAt: commonBaseline(all),
    empty: all.length === 0,
  }
}
