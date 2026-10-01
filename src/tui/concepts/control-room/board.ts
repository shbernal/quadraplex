import { loadConfig, ttlMs } from '../../../core/config.ts'
import { compactNumber } from '../../../core/format.ts'
import type { Ecosystem, Target } from '../../../core/types.ts'
import { buildProjects, type Project } from '../../model.ts'
import { C, G, seg, type Line } from './cells.ts'

/**
 * One pane per domain. A project is filed in every pane it has a target in, so a package
 * with a repo reads its downloads in the registries pane and its stars in the GitHub pane,
 * and the cursor can hop between the two rows by project key.
 */

export type PaneId = 'github' | 'registries' | 'extensions'

export type Status = 'error' | 'stale' | 'new' | 'up' | 'down' | 'quiet'

export type Row = {
  /** The project key, shared by every row the project owns across panes. */
  key: string
  project: Project
  targets: Target[]
  name: string
  url: string
  status: Status
}

export type Column = {
  head: Line
  width: number
  /** Higher survives longer when the pane is too narrow for every column. */
  pri: number
  /** Icon strips read from the left; numbers align right. */
  left?: boolean
  cell: (row: Row) => Line
}

export type Pane = {
  id: PaneId
  title: string
  icon: string
  color: string | undefined
  sources: Ecosystem[]
  columns: Column[]
  rows: Row[]
  /** Gauges inset in the top border, so a collapsed pane still reads. */
  summary: Line
  /** Oldest fetch behind the pane, the age every row in it can claim. */
  asOf: string | null
  ttl: number
  stale: number
}

/** One lamp per store on the systems panel: how much it holds and how old that is. */
export type Source = {
  ecosystem: Ecosystem
  icon: string
  color: string | undefined
  targets: number
  asOf: string | null
  ttl: number
  stale: number
  errors: number
  fresh: number
}

export type Board = {
  now: number
  panes: Pane[]
  sources: Source[]
  baselineAt: string | null
  newest: string | null
}

const SOURCE_ICON: Record<Ecosystem, [string, string | undefined]> = {
  github: [G.github, C.github],
  npm: [G.npm, C.npm],
  pypi: [G.pypi, C.pypi],
  cws: [G.chrome, C.chrome],
  amo: [G.firefox, C.firefox],
}

export const STATUS: Record<Status, { glyph: string; color: string | undefined }> = {
  error: { glyph: '✗', color: C.down },
  stale: { glyph: G.hourglass, color: C.warn },
  new: { glyph: '◌', color: C.muted },
  up: { glyph: '●', color: C.up },
  down: { glyph: '●', color: C.down },
  quiet: { glyph: '·', color: C.muted },
}

const HOUR = 3_600_000

export function age(iso: string | null | undefined, now: number): string {
  if (!iso) return '·'
  const hours = (now - Date.parse(iso)) / HOUR
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))}m`
  if (hours < 48) return `${Math.round(hours)}h`
  if (hours < 24 * 60) return `${Math.round(hours / 24)}d`
  return `${Math.round(hours / 24 / 30)}mo`
}

/** null is unknown, never zero: it reads "new". */
export function delta(d: number | null | undefined): Line {
  if (d === null || d === undefined) return [seg('new', C.muted, { i: true })]
  if (d === 0) return [seg('·', C.muted)]
  return [seg(`${d > 0 ? '▲' : '▼'}${compactNumber(Math.abs(d))}`, d > 0 ? C.up : C.down)]
}

const num = (n: unknown, color?: string): Line =>
  typeof n === 'number'
    ? [seg(compactNumber(n), n === 0 ? C.muted : color)]
    : [seg('?', C.muted, { d: true })]

const str = (v: unknown) => (typeof v === 'string' ? v : null)

function status(targets: Target[], key: string): Status {
  if (targets.some((t) => t.errors?.length)) return 'error'
  if (targets.some((t) => t.deltas === null)) return 'new'
  const ds = targets.map((t) => t.deltas?.[key]).filter((d): d is number => typeof d === 'number')
  const sum = ds.reduce((a, b) => a + b, 0)
  return sum > 0 ? 'up' : sum < 0 ? 'down' : 'quiet'
}

function oldest(targets: Target[]): string | null {
  return targets.reduce<string | null>((o, t) => (!o || t.fetchedAt < o ? t.fetchedAt : o), null)
}

/** The other domains a project ships to, so a row says where else to look for it. */
function elsewhere(project: Project, except: Ecosystem[]): Line {
  const icons: [Ecosystem, string, string | undefined][] = [
    ['github', G.github, C.github],
    ['npm', G.npm, C.npm],
    ['pypi', G.pypi, C.pypi],
    ['cws', G.chrome, C.chrome],
    ['amo', G.firefox, C.firefox],
  ]
  return icons
    .filter(([e]) => !except.includes(e) && project.targets.some((t) => t.ecosystem === e))
    .flatMap(([, g, c], i) => (i ? [seg(' '), seg(g, c)] : [seg(g, c)]))
}

const sum = (targets: Target[], key: string) =>
  targets.reduce((n, t) => {
    const v = t.metrics[key]
    return n + (typeof v === 'number' ? v : 0)
  }, 0)

function sumDelta(targets: Target[], key: string): number | null {
  const ds = targets.map((t) => (t.deltas ? (t.deltas[key] ?? null) : null))
  return ds.includes(null) ? null : ds.reduce((a, b) => a! + b!, 0)
}

// ---------------------------------------------------------------- GitHub

function githubPane(projects: Project[], now: number): Omit<Pane, 'asOf' | 'ttl' | 'stale'> {
  const rows: Row[] = projects.flatMap((project) =>
    project.targets
      .filter((t) => t.ecosystem === 'github')
      .map((t) => ({
        key: project.key,
        project,
        targets: [t],
        name: t.name.split('/').at(-1)!,
        url: t.url,
        status: status([t], 'stars'),
      })),
  )
  rows.sort(
    (a, b) =>
      (b.targets[0]!.metrics.openPRs as number) - (a.targets[0]!.metrics.openPRs as number) ||
      sum(b.targets, 'stars') - sum(a.targets, 'stars') ||
      String(b.targets[0]!.metrics.lastPush).localeCompare(String(a.targets[0]!.metrics.lastPush)),
  )
  const m = (r: Row, k: string) => r.targets[0]!.metrics[k]
  const columns: Column[] = [
    { head: [], width: 3, pri: 2, left: true, cell: (r) => elsewhere(r.project, ['github']) },
    { head: [seg(G.star, C.star)], width: 4, pri: 9, cell: (r) => num(m(r, 'stars'), C.star) },
    {
      head: [seg('Δ', C.muted)],
      width: 4,
      pri: 8,
      cell: (r) => delta(r.targets[0]!.deltas ? (r.targets[0]!.deltas.stars ?? null) : null),
    },
    { head: [seg(G.fork, C.muted)], width: 3, pri: 3, cell: (r) => num(m(r, 'forks')) },
    {
      head: [seg(G.issue, C.issue)],
      width: 3,
      pri: 7,
      cell: (r) => num(m(r, 'openIssues'), C.issue),
    },
    { head: [seg(G.pr, C.pr)], width: 3, pri: 7, cell: (r) => num(m(r, 'openPRs'), C.pr) },
    {
      head: [seg(G.commit, C.muted)],
      width: 4,
      pri: 5,
      cell: (r) => {
        const pushed = str(m(r, 'lastPush'))
        return [
          seg(age(pushed, now), pushed && now - Date.parse(pushed) < 48 * HOUR ? C.text : C.muted),
        ]
      },
    },
    {
      head: [],
      width: 1,
      pri: 6,
      cell: (r) =>
        m(r, 'archived') === 'yes'
          ? [seg(G.archive, C.muted)]
          : r.project.drift.unreleased
            ? [seg('⇡', C.accent)]
            : [],
    },
  ]
  const ts = rows.flatMap((r) => r.targets)
  const stars = sum(ts, 'stars')
  return {
    id: 'github',
    title: 'GITHUB',
    icon: G.github,
    color: C.github,
    sources: ['github'],
    columns,
    rows,
    summary: [
      seg(`${G.repo} ${rows.length}`, C.text),
      seg('  '),
      seg(`${G.star} ${stars}`, C.star),
      seg(' '),
      ...delta(sumDelta(ts, 'stars')),
      seg('  '),
      seg(`${G.issue} ${sum(ts, 'openIssues')}`, C.issue),
      seg('  '),
      seg(`${G.pr} ${sum(ts, 'openPRs')}`, C.pr),
    ],
  }
}

// ---------------------------------------------------------------- registries

function registriesPane(
  projects: Project[],
  now: number,
  own: string | undefined,
): Omit<Pane, 'asOf' | 'ttl' | 'stale'> {
  const rows: Row[] = projects.flatMap((project) =>
    project.targets
      .filter((t) => t.ecosystem === 'npm' || t.ecosystem === 'pypi')
      .map((t) => ({
        key: project.key,
        project,
        targets: [t],
        name: own && t.name.startsWith(`@${own}/`) ? t.name.slice(own.length + 2) : t.name,
        url: t.url,
        status: status([t], 'downloadsWeek'),
      })),
  )
  rows.sort((a, b) => sum(b.targets, 'downloadsWeek') - sum(a.targets, 'downloadsWeek'))
  const m = (r: Row, k: string) => r.targets[0]!.metrics[k]
  const columns: Column[] = [
    {
      head: [],
      width: 1,
      pri: 10,
      cell: (r) =>
        r.targets[0]!.ecosystem === 'npm' ? [seg(G.npm, C.npm)] : [seg(G.pypi, C.pypi)],
    },
    {
      head: [seg(G.tag, C.muted)],
      width: 7,
      pri: 6,
      cell: (r) => [seg(str(m(r, 'version')) ?? '?', C.accent)],
    },
    {
      head: [seg(G.download, C.text)],
      width: 5,
      pri: 9,
      cell: (r) => num(m(r, 'downloadsWeek'), C.text),
    },
    {
      head: [seg('Δ', C.muted)],
      width: 5,
      pri: 8,
      cell: (r) =>
        delta(r.targets[0]!.deltas ? (r.targets[0]!.deltas.downloadsWeek ?? null) : null),
    },
    {
      head: [seg(G.calendar, C.muted)],
      width: 5,
      pri: 4,
      cell: (r) => num(m(r, 'downloadsMonth'), C.muted),
    },
    {
      head: [seg(G.rocket, C.muted)],
      width: 4,
      pri: 5,
      cell: (r) => [seg(age(str(m(r, 'lastPublish')), now), C.muted)],
    },
    {
      head: [],
      width: 2,
      pri: 7,
      cell: (r) => [
        r.project.drift.versions ? seg('≠', C.warn) : seg(' '),
        m(r, 'deprecated') && m(r, 'deprecated') !== 'no'
          ? seg('†', C.down)
          : r.project.drift.unreleased
            ? seg('⇡', C.accent)
            : seg(' '),
      ],
    },
  ]
  const ts = rows.flatMap((r) => r.targets)
  const npm = ts.filter((t) => t.ecosystem === 'npm').length
  return {
    id: 'registries',
    title: 'REGISTRIES',
    icon: G.npm,
    color: C.registries,
    sources: ['npm', 'pypi'],
    columns,
    rows,
    summary: [
      seg(`${G.npm} ${npm}`, C.npm),
      seg(' '),
      seg(`${G.pypi} ${ts.length - npm}`, C.pypi),
      seg('  '),
      seg(`${G.download} ${compactNumber(sum(ts, 'downloadsWeek'))}`, C.text),
      seg(' '),
      ...delta(sumDelta(ts, 'downloadsWeek')),
    ],
  }
}

// ---------------------------------------------------------------- extensions

/** Google's bucket is a label, kept verbatim and marked so nobody subtracts two of them. */
function bucket(t: Target | undefined): Line {
  if (!t) return [seg('·', C.muted)]
  const users = t.metrics.users
  return typeof users === 'string' ? [seg(`≈${users}`, C.chrome)] : [seg('?', C.muted, { d: true })]
}

function extensionsPane(projects: Project[], now: number): Omit<Pane, 'asOf' | 'ttl' | 'stale'> {
  const rows: Row[] = projects
    .filter((p) => p.targets.some((t) => t.ecosystem === 'cws' || t.ecosystem === 'amo'))
    .map((project) => {
      const targets = project.targets.filter((t) => t.ecosystem === 'cws' || t.ecosystem === 'amo')
      return {
        key: project.key,
        project,
        targets,
        name: project.name,
        url: targets[0]!.url,
        status: status(targets, 'users'),
      }
    })
  const cws = (r: Row) => r.targets.find((t) => t.ecosystem === 'cws')
  const amo = (r: Row) => r.targets.find((t) => t.ecosystem === 'amo')
  rows.sort(
    (a, b) =>
      sum(
        b.targets.filter((t) => t.ecosystem === 'amo'),
        'users',
      ) -
        sum(
          a.targets.filter((t) => t.ecosystem === 'amo'),
          'users',
        ) || a.name.localeCompare(b.name),
  )
  const columns: Column[] = [
    { head: [seg(G.chrome, C.chrome), seg(' ')], width: 6, pri: 8, cell: (r) => bucket(cws(r)) },
    {
      head: [seg(G.firefox, C.firefox), seg(' ')],
      width: 4,
      pri: 9,
      cell: (r) => (amo(r) ? num(amo(r)!.metrics.users, C.firefox) : [seg('·', C.muted)]),
    },
    {
      head: [seg('Δ', C.muted)],
      width: 4,
      pri: 8,
      cell: (r) => {
        const t = amo(r)
        return t ? delta(t.deltas ? (t.deltas.users ?? null) : null) : [seg('·', C.muted)]
      },
    },
    {
      head: [seg('★', C.star)],
      width: 3,
      pri: 5,
      cell: (r) =>
        r.project.rating ? [seg(r.project.rating.score.toFixed(1), C.star)] : [seg('·', C.muted)],
    },
    {
      head: [seg(G.tag, C.muted)],
      width: 9,
      pri: 7,
      cell: (r) => {
        const v = r.project.drift
        if (v.versions) return [seg(v.versions.map((x) => x.version).join('≠'), C.warn)]
        return [seg(v.version ?? '?', C.accent)]
      },
    },
    {
      head: [seg(G.rocket, C.muted)],
      width: 4,
      pri: 4,
      cell: (r) => {
        const last = r.targets
          .map((t) => str(t.metrics.lastPublish))
          .filter((v): v is string => v !== null)
          .toSorted((a, b) => a.localeCompare(b))
          .at(-1)
        return [seg(age(last, now), C.muted)]
      },
    },
    { head: [], width: 3, pri: 3, left: true, cell: (r) => elsewhere(r.project, ['cws', 'amo']) },
  ]
  const ts = rows.flatMap((r) => r.targets)
  const ff = ts.filter((t) => t.ecosystem === 'amo')
  return {
    id: 'extensions',
    title: 'EXTENSIONS',
    icon: G.puzzle,
    color: C.extensions,
    sources: ['cws', 'amo'],
    columns,
    rows,
    summary: [
      seg(`${G.chrome} ${ts.length - ff.length}`, C.chrome),
      seg(' '),
      seg(`${G.firefox} ${ff.length}`, C.firefox),
      seg('  '),
      seg(`${G.users} ${sum(ff, 'users')}`, C.text),
      seg(' '),
      ...delta(sumDelta(ff, 'users')),
    ],
  }
}

// ---------------------------------------------------------------- board

export function buildBoard(now = Date.now()): Board {
  const config = loadConfig()
  const projects = buildProjects()
  const panes = [
    githubPane(projects, now),
    registriesPane(projects, now, config.accounts.npm),
    extensionsPane(projects, now),
  ].map((pane): Pane => {
    const targets = pane.rows.flatMap((r) => r.targets)
    const stale = targets.filter((t) => t.stale).length
    // A wholly stale pane says so once, in its border. Only a partly stale one marks rows,
    // because there the hourglass tells some rows apart from the rest.
    const rows =
      stale && stale < targets.length
        ? pane.rows.map((r) =>
            r.status !== 'error' && r.targets.some((t) => t.stale)
              ? { ...r, status: 'stale' as const }
              : r,
          )
        : pane.rows
    return {
      ...pane,
      rows,
      asOf: oldest(targets),
      ttl: Math.min(...pane.sources.map((s) => ttlMs(config, s))),
      stale,
    }
  })
  const all = projects.flatMap((p) => p.targets)
  const baselines = all.map((t) => t.deltaBaselineAt).filter((b): b is string => Boolean(b))
  const order: Ecosystem[] = ['github', 'npm', 'pypi', 'cws', 'amo']
  const sources = order.flatMap((ecosystem): Source[] => {
    const mine = all.filter((t) => t.ecosystem === ecosystem)
    if (!mine.length) return []
    const [icon, color] = SOURCE_ICON[ecosystem]
    return [
      {
        ecosystem,
        icon,
        color,
        targets: mine.length,
        asOf: oldest(mine),
        ttl: ttlMs(config, ecosystem),
        stale: mine.filter((t) => t.stale).length,
        errors: mine.filter((t) => t.errors?.length).length,
        fresh: mine.filter((t) => t.deltas === null).length,
      },
    ]
  })
  return {
    now,
    panes,
    sources,
    baselineAt: baselines.toSorted().at(-1) ?? null,
    newest:
      all
        .map((t) => t.fetchedAt)
        .toSorted()
        .at(-1) ?? null,
  }
}
