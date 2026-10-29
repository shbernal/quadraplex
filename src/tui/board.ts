import { configuredEcosystems, loadConfig, ttlMs } from '../core/config.ts'
import { compactNumber } from '../core/format.ts'
import type { Ecosystem, Skill, Target } from '../core/types.ts'
import { skillSlug } from '../sources/skills.ts'
import { buildProjects, matches, REGISTRIES, shortName, type Project } from './model.ts'
import { C, G, seg, type Line } from './cells.ts'

/**
 * One pane per domain. A project is filed in every pane it has a target in, so a package
 * with a repo reads its downloads in the registries pane and its stars in the GitHub pane,
 * and the cursor can hop between the two rows by project key.
 */

export type PaneId = 'github' | 'registries' | 'extensions' | 'skills'

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

type Column = {
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
type Source = {
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

function sourceIcon(e: Ecosystem): [string, string | undefined] {
  const icons: Record<Ecosystem, [string, string | undefined]> = {
    github: [G.github, C.github],
    npm: [G.npm, C.npm],
    pypi: [G.pypi, C.pypi],
    ghcr: [G.ghcr, C.ghcr],
    dockerhub: [G.dockerhub, C.dockerhub],
    rubygems: [G.rubygems, C.rubygems],
    jsr: [G.jsr, C.jsr],
    aur: [G.aur, C.aur],
    packagist: [G.packagist, C.packagist],
    nuget: [G.nuget, C.nuget],
    cws: [G.chrome, C.chrome],
    amo: [G.firefox, C.firefox],
    clawhub: [G.clawhub, C.clawhub],
    vscode: [G.vscode, C.vscode],
    openvsx: [G.openvsx, C.openvsx],
  }
  return icons[e]
}

export function statusMark(s: Status): {
  glyph: string
  color: string | undefined
} {
  return {
    error: { glyph: '✗', color: C.down },
    stale: { glyph: G.hourglass, color: C.warn },
    new: { glyph: '◌', color: C.muted },
    up: { glyph: '●', color: C.up },
    down: { glyph: '●', color: C.down },
    quiet: { glyph: '·', color: C.muted },
  }[s]
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
    ['ghcr', G.ghcr, C.ghcr],
    ['dockerhub', G.dockerhub, C.dockerhub],
    ['rubygems', G.rubygems, C.rubygems],
    ['jsr', G.jsr, C.jsr],
    ['aur', G.aur, C.aur],
    ['packagist', G.packagist, C.packagist],
    ['nuget', G.nuget, C.nuget],
    ['cws', G.chrome, C.chrome],
    ['amo', G.firefox, C.firefox],
    ['vscode', G.vscode, C.vscode],
    ['openvsx', G.openvsx, C.openvsx],
    ['clawhub', G.clawhub, C.clawhub],
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

function githubPane(
  projects: Project[],
  now: number,
  shown: Set<Ecosystem>,
): Omit<Pane, 'asOf' | 'ttl' | 'stale'> {
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
  const prs = (r: Row) => {
    const v = r.targets[0]!.metrics.openPRs
    return typeof v === 'number' ? v : -1
  }
  rows.sort(
    (a, b) =>
      prs(b) - prs(a) ||
      sum(b.targets, 'stars') - sum(a.targets, 'stars') ||
      String(b.targets[0]!.metrics.lastPush).localeCompare(String(a.targets[0]!.metrics.lastPush)),
  )
  const m = (r: Row, k: string) => r.targets[0]!.metrics[k]
  const columns: Column[] = [
    {
      head: [],
      width: 3,
      pri: 2,
      left: true,
      cell: (r) => elsewhere(r.project, ['github']),
    },
    {
      head: [seg(G.star, C.star)],
      width: 4,
      pri: 9,
      cell: (r) => num(m(r, 'stars'), C.star),
    },
    {
      head: [seg('Δ', C.muted)],
      width: 4,
      pri: 8,
      cell: (r) => delta(r.targets[0]!.deltas ? (r.targets[0]!.deltas.stars ?? null) : null),
    },
    {
      head: [seg(G.fork, C.muted)],
      width: 3,
      pri: 3,
      cell: (r) => num(m(r, 'forks')),
    },
    {
      head: [seg(G.issue, C.issue)],
      width: 3,
      pri: 7,
      cell: (r) => num(m(r, 'openIssues'), C.issue),
    },
    {
      head: [seg(G.pr, C.pr)],
      width: 3,
      pri: 7,
      cell: (r) => num(m(r, 'openPRs'), C.pr),
    },
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
    // Commits past the release tag. A release only a registry knows has no tag to count
    // from, so the unreleased push still shows, uncounted.
    {
      head: [seg('⇡', C.unreleased)],
      width: 3,
      pri: 5,
      cell: (r) => {
        const n = m(r, 'unreleasedCommits')
        if (typeof n === 'number') return n ? [seg(String(n), C.unreleased)] : []
        return r.project.drift.unreleased ? [seg('⇡', C.unreleased)] : []
      },
    },
    // Only a repo that has released carries these, the rest read as absent rather than zero.
    {
      head: [seg(G.tag, C.muted)],
      width: 7,
      pri: 4,
      cell: (r) => {
        const v = m(r, 'version')
        return v === undefined ? [seg('·', C.muted)] : [seg(str(v) ?? '?', C.accent)]
      },
    },
    {
      head: [seg(G.download, C.text)],
      width: 4,
      pri: 4,
      cell: (r) =>
        m(r, 'downloadsTotal') === undefined
          ? [seg('·', C.muted)]
          : num(m(r, 'downloadsTotal'), C.text),
    },
    // With a second store the installs move to their own pane, so they are not read twice.
    ...(shown.has('clawhub')
      ? []
      : [
          {
            head: [seg(G.skill, C.accent)],
            width: 4,
            pri: 4,
            cell: (r: Row) => {
              if (m(r, 'skills') === undefined) return [seg('·', C.muted)]
              // Published but never installed through the CLI, so skills.sh has no count.
              if (m(r, 'skillInstalls') === null) return [seg(G.skill, C.muted)]
              return num(m(r, 'skillInstalls'), C.accent)
            },
          },
        ]),
    {
      head: [],
      width: 1,
      pri: 6,
      cell: (r) => (m(r, 'archived') === 'yes' ? [seg(G.archive, C.muted)] : []),
    },
  ]
  const ts = rows.flatMap((r) => r.targets)
  const stars = sum(ts, 'stars')
  const skills = shown.has('clawhub') ? 0 : sum(ts, 'skills')
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
      ...(skills ? [seg('  '), seg(`${G.skill} ${skills}`, C.accent)] : []),
    ],
  }
}

// ---------------------------------------------------------------- registries

/**
 * Docker Hub, RubyGems and NuGet count downloads for all time and nothing per day, so their
 * rows show the total marked Σ and move by the downloads since the delta baseline, not by a
 * change in the week.
 * The AUR counts no downloads at all, so its row shows lifetime votes the same way.
 */
const LIFETIME: Partial<Record<Ecosystem, [key: string, mark: string]>> = {
  dockerhub: ['downloadsTotal', 'Σ'],
  rubygems: ['downloadsTotal', 'Σ'],
  nuget: ['downloadsTotal', 'Σ'],
  aur: ['votes', '★'],
}
const lifetime = (t: Target) => LIFETIME[t.ecosystem]
const rateKey = (t: Target) => lifetime(t)?.[0] ?? 'downloadsWeek'

function registriesPane(
  projects: Project[],
  now: number,
  own: string | undefined,
): Omit<Pane, 'asOf' | 'ttl' | 'stale'> {
  const rows: Row[] = projects.flatMap((project) =>
    project.targets
      .filter((t) => REGISTRIES.includes(t.ecosystem))
      .map((t) => ({
        key: project.key,
        project,
        targets: [t],
        name: shortName(t, own),
        url: t.url,
        status: status([t], rateKey(t)),
      })),
  )
  rows.sort((a, b) => sum(b.targets, 'downloadsWeek') - sum(a.targets, 'downloadsWeek'))
  const m = (r: Row, k: string) => r.targets[0]!.metrics[k]
  const columns: Column[] = [
    {
      head: [],
      width: 1,
      pri: 10,
      cell: (r) => {
        const [g, c] = sourceIcon(r.targets[0]!.ecosystem)
        return [seg(g, c)]
      },
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
      cell: (r) => {
        const total = lifetime(r.targets[0]!)
        return total
          ? [seg(total[1], C.muted), ...num(m(r, total[0]), C.text)]
          : num(m(r, 'downloadsWeek'), C.text)
      },
    },
    {
      head: [seg('Δ', C.muted)],
      width: 5,
      pri: 8,
      cell: (r) => {
        const t = r.targets[0]!
        return delta(t.deltas ? (t.deltas[rateKey(t)] ?? null) : null)
      },
    },
    {
      head: [seg(G.calendar, C.muted)],
      width: 5,
      pri: 4,
      cell: (r) =>
        lifetime(r.targets[0]!) ? [seg('·', C.muted)] : num(m(r, 'downloadsMonth'), C.muted),
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
          : m(r, 'outOfDate') && m(r, 'outOfDate') !== 'no'
            ? seg('!', C.warn)
            : r.project.drift.unreleased
              ? seg('⇡', C.unreleased)
              : seg(' '),
      ],
    },
  ]
  const ts = rows.flatMap((r) => r.targets)
  const count = (e: Ecosystem) => ts.filter((t) => t.ecosystem === e).length
  const weekly = ts.filter((t) => !lifetime(t))
  return {
    id: 'registries',
    title: 'REGISTRIES',
    icon: G.package,
    color: C.registries,
    sources: REGISTRIES,
    columns,
    rows,
    summary: [
      ...REGISTRIES.flatMap((e) => {
        const [g, c] = sourceIcon(e)
        return count(e) ? [seg(`${g} ${count(e)}`, c), seg(' ')] : []
      }),
      seg(' '),
      seg(`${G.download} ${compactNumber(sum(weekly, 'downloadsWeek'))}`, C.text),
      seg(' '),
      ...delta(sumDelta(weekly, 'downloadsWeek')),
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

/** Browser extension stores, then editor extension stores. */
const EXTENSIONS: Ecosystem[] = ['cws', 'amo', 'vscode', 'openvsx']

/**
 * The editor stores count for all time and nothing per day, so their columns show the
 * lifetime count marked Σ and move by what was added since the delta baseline.
 */
const EDITOR_KEY: Partial<Record<Ecosystem, string>> = {
  vscode: 'installs',
  openvsx: 'downloadsTotal',
}

function editorColumns(e: 'vscode' | 'openvsx', pri: number): Column[] {
  const [glyph, color] = sourceIcon(e)
  const key = EDITOR_KEY[e]!
  const target = (r: Row) => r.targets.find((t) => t.ecosystem === e)
  return [
    {
      head: [seg(glyph, color), seg(' ')],
      width: 5,
      pri,
      cell: (r) => {
        const t = target(r)
        return t ? [seg('Σ', C.muted), ...num(t.metrics[key], color)] : [seg('·', C.muted)]
      },
    },
    {
      head: [seg('Δ', C.muted)],
      width: 4,
      pri: pri - 1,
      cell: (r) => {
        const t = target(r)
        return t ? delta(t.deltas ? (t.deltas[key] ?? null) : null) : [seg('·', C.muted)]
      },
    },
  ]
}

function editorSummary(ts: Target[], e: 'vscode' | 'openvsx'): Line {
  const mine = ts.filter((t) => t.ecosystem === e)
  const [glyph, color] = sourceIcon(e)
  const key = EDITOR_KEY[e]!
  return [
    seg(`${glyph} ${mine.length} Σ${compactNumber(sum(mine, key))}`, color),
    seg(' '),
    ...delta(sumDelta(mine, key)),
  ]
}

function extensionsPane(
  projects: Project[],
  now: number,
  shown: Set<Ecosystem>,
): Omit<Pane, 'asOf' | 'ttl' | 'stale'> {
  const rows: Row[] = projects
    .filter((p) => p.targets.some((t) => EXTENSIONS.includes(t.ecosystem)))
    .map((project) => {
      const targets = project.targets.filter((t) => EXTENSIONS.includes(t.ecosystem))
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
  // Each store's count in turn, never summed across units, then the name.
  const ranks: [Ecosystem, string][] = [
    ['amo', 'users'],
    ['vscode', 'installs'],
    ['openvsx', 'downloadsTotal'],
  ]
  const rank = (r: Row, [e, key]: [Ecosystem, string]) =>
    sum(
      r.targets.filter((t) => t.ecosystem === e),
      key,
    )
  rows.sort(
    (a, b) =>
      ranks.reduce((d, k) => d || rank(b, k) - rank(a, k), 0) || a.name.localeCompare(b.name),
  )
  // A store the config leaves out takes its columns and gauge with it, rather than a row of ·.
  const chrome: Column[] = [
    {
      head: [seg(G.chrome, C.chrome), seg(' ')],
      width: 6,
      pri: 8,
      cell: (r) => bucket(cws(r)),
    },
  ]
  const firefox: Column[] = [
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
  ]
  const columns: Column[] = [
    ...(shown.has('cws') ? chrome : []),
    ...(shown.has('amo') ? firefox : []),
    ...(shown.has('vscode') ? editorColumns('vscode', 9) : []),
    ...(shown.has('openvsx') ? editorColumns('openvsx', 8) : []),
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
    {
      head: [],
      width: 3,
      pri: 3,
      left: true,
      cell: (r) => elsewhere(r.project, EXTENSIONS),
    },
  ]
  const ts = rows.flatMap((r) => r.targets)
  const ff = ts.filter((t) => t.ecosystem === 'amo')
  const parts: Line[] = [
    ...(shown.has('cws')
      ? [[seg(`${G.chrome} ${ts.filter((t) => t.ecosystem === 'cws').length}`, C.chrome)]]
      : []),
    ...(shown.has('amo')
      ? [
          [
            seg(`${G.firefox} ${ff.length} ${G.users} ${sum(ff, 'users')}`, C.firefox),
            seg(' '),
            ...delta(sumDelta(ff, 'users')),
          ],
        ]
      : []),
    ...(shown.has('vscode') ? [editorSummary(ts, 'vscode')] : []),
    ...(shown.has('openvsx') ? [editorSummary(ts, 'openvsx')] : []),
  ]
  return {
    id: 'extensions',
    title: 'EXTENSIONS',
    icon: G.puzzle,
    color: C.extensions,
    sources: EXTENSIONS,
    columns,
    rows,
    summary: parts.flatMap((part, i) => (i ? [seg('  ')] : []).concat(part)),
  }
}

// ---------------------------------------------------------------- skills

/** One skill, as skills.sh counts it from its repo and as ClawHub counts it as published. */
type SkillEntry = {
  sh: Skill | null
  repo: Target | undefined
  hub: Target | undefined
}

/** Unknown to both skills.sh and ClawHub stays unknown, never zero. */
function installTotal(e: SkillEntry): number | null {
  const counts = [e.sh?.installs, e.hub?.metrics.installs].filter(
    (n): n is number => typeof n === 'number',
  )
  return counts.length ? counts.reduce((a, b) => a + b, 0) : null
}

/**
 * A row per skill, not per repo, because ClawHub publishes skills one at a time. The two
 * stores count different CLIs and ClawHub discards skills.sh's events, so their installs
 * add up. skills.sh keeps no history per skill, so only ClawHub's count carries a delta.
 */
function skillsPane(projects: Project[], now: number): Omit<Pane, 'asOf' | 'ttl' | 'stale'> {
  const entries = new Map<Row, SkillEntry>()
  const rows: Row[] = projects.flatMap((project) => {
    const bySlug = new Map<string, SkillEntry>()
    for (const reading of project.skills) {
      const repo = project.targets.find((t) => t.id === reading.id)
      for (const sh of reading.skills) bySlug.set(skillSlug(sh.name), { sh, repo, hub: undefined })
    }
    for (const hub of project.targets.filter((t) => t.ecosystem === 'clawhub')) {
      const seen = bySlug.get(hub.name)
      bySlug.set(hub.name, seen ? { ...seen, hub } : { sh: null, repo: undefined, hub })
    }
    return [...bySlug].map(([slug, e]) => {
      const targets = [e.repo, e.hub].filter((t): t is Target => t !== undefined)
      const row: Row = {
        key: project.key,
        project,
        targets,
        name: slug,
        url: e.hub?.url ?? `https://skills.sh/${e.repo!.name}/${slug}`,
        status: e.hub ? status([e.hub], 'installs') : status(targets, 'skillInstalls'),
      }
      entries.set(row, e)
      return row
    })
  })
  const at = (r: Row) => entries.get(r)!
  rows.sort(
    (a, b) =>
      (installTotal(at(b)) ?? -1) - (installTotal(at(a)) ?? -1) || a.name.localeCompare(b.name),
  )
  const columns: Column[] = [
    {
      head: [seg(G.skill, C.accent)],
      width: 4,
      pri: 8,
      cell: (r) => {
        const { sh } = at(r)
        if (!sh) return [seg('·', C.muted)]
        // In the repo but never installed through the CLI, so skills.sh has no count.
        return sh.installs === null ? [seg(G.skill, C.muted)] : num(sh.installs, C.accent)
      },
    },
    {
      head: [seg(G.clawhub, C.clawhub)],
      width: 4,
      pri: 8,
      cell: (r) => {
        const { hub } = at(r)
        return hub ? num(hub.metrics.installs, C.clawhub) : [seg('·', C.muted)]
      },
    },
    {
      head: [seg('Δ', C.muted)],
      width: 4,
      pri: 7,
      cell: (r) => {
        const { hub } = at(r)
        return hub ? delta(hub.deltas ? (hub.deltas.installs ?? null) : null) : [seg('·', C.muted)]
      },
    },
    {
      head: [seg('Σ', C.text)],
      width: 4,
      pri: 9,
      cell: (r) => {
        const total = installTotal(at(r))
        return total === null ? [seg('?', C.muted, { d: true })] : num(total, C.text)
      },
    },
    {
      head: [seg(G.tag, C.muted)],
      width: 7,
      pri: 4,
      cell: (r) => {
        const { hub } = at(r)
        return hub ? [seg(str(hub.metrics.version) ?? '?', C.accent)] : [seg('·', C.muted)]
      },
    },
    {
      head: [seg(G.rocket, C.muted)],
      width: 4,
      pri: 5,
      cell: (r) => [seg(age(str(at(r).hub?.metrics.lastPublish), now), C.muted)],
    },
  ]
  const all = [...entries.values()]
  const shInstalls = all.reduce((n, e) => n + (e.sh?.installs ?? 0), 0)
  const hubs = all.flatMap((e) => (e.hub ? [e.hub] : []))
  const hubInstalls = sum(hubs, 'installs')
  // The repo's total is the only skills.sh count with history, so it carries that side.
  const repos = [...new Set(all.flatMap((e) => (e.repo ? [e.repo] : [])))].filter(
    (t) => typeof t.metrics.skillInstalls === 'number',
  )
  const moved = [sumDelta(repos, 'skillInstalls'), sumDelta(hubs, 'installs')]
  const change = moved.includes(null) ? null : moved[0]! + moved[1]!
  return {
    id: 'skills',
    title: 'SKILLS',
    icon: G.skill,
    color: C.skills,
    sources: ['clawhub'],
    columns,
    rows,
    summary: [
      seg(`${G.skill} ${compactNumber(shInstalls)}`, C.accent),
      seg('  '),
      seg(`${G.clawhub} ${compactNumber(hubInstalls)}`, C.clawhub),
      seg('  '),
      seg(`Σ ${compactNumber(shInstalls + hubInstalls)}`, C.text),
      seg(' '),
      ...delta(change),
    ],
  }
}

// ---------------------------------------------------------------- board

export function buildBoard(now = Date.now()): Board {
  const config = loadConfig()
  const shown = configuredEcosystems(config)
  const projects = buildProjects()
  // A pane is drawn for an ecosystem the config names, even before it holds a target.
  const panes = [
    githubPane(projects, now, shown),
    registriesPane(projects, now, config.accounts.npm),
    extensionsPane(projects, now, shown),
    skillsPane(projects, now),
  ]
    .filter((pane) => pane.sources.some((s) => shown.has(s)))
    .map((pane): Pane => {
      const targets = pane.rows.flatMap((r) => r.targets)
      const stale = targets.filter((t) => t.stale).length
      // A wholly stale pane says so once, in its border. Only a partly stale one marks rows,
      // because there the hourglass tells some rows apart from the rest.
      if (stale && stale < targets.length) {
        for (const r of pane.rows)
          if (r.status !== 'error' && r.targets.some((t) => t.stale)) r.status = 'stale'
      }
      return Object.assign(pane, {
        asOf: oldest(targets),
        ttl: Math.min(...pane.sources.filter((s) => shown.has(s)).map((s) => ttlMs(config, s))),
        stale,
      })
    })
  const all = projects.flatMap((p) => p.targets)
  const baselines = all.map((t) => t.deltaBaselineAt).filter((b): b is string => Boolean(b))
  const order: Ecosystem[] = [
    'github',
    'npm',
    'pypi',
    'packagist',
    'nuget',
    'ghcr',
    'dockerhub',
    'rubygems',
    'jsr',
    'aur',
    'cws',
    'amo',
    'vscode',
    'openvsx',
    'clawhub',
  ]
  const sources = order.flatMap((ecosystem): Source[] => {
    if (!shown.has(ecosystem)) return []
    const mine = all.filter((t) => t.ecosystem === ecosystem)
    const [icon, color] = sourceIcon(ecosystem)
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

// ---------------------------------------------------------------- view

/** "default" is each pane's own order, so cycling sorts always has a way back to it. */
export const SORTS = ['default', 'drift', 'name', 'age'] as const

type Sort = (typeof SORTS)[number]

/** What the panes are showing: one query across all of them, one sort per pane. */
export type View = { query: string; sorts: Partial<Record<PaneId, Sort>> }

export const DEFAULT_VIEW: View = { query: '', sorts: {} }

const driftRank = (r: Row) => (r.project.drift.versions ? 0 : r.project.drift.unreleased ? 1 : 2)

/** The newest push or publish behind a row, the activity "age" sorts by. */
function activity(r: Row): string {
  return r.targets
    .flatMap((t) => [str(t.metrics.lastPush), str(t.metrics.lastPublish)])
    .reduce<string>((a, v) => (v && v > a ? v : a), '')
}

const COMPARE: Record<Exclude<Sort, 'default'>, (a: Row, b: Row) => number> = {
  drift: (a, b) => driftRank(a) - driftRank(b),
  name: (a, b) => a.name.localeCompare(b.name),
  age: (a, b) => activity(b).localeCompare(activity(a)),
}

/**
 * Filter and sort on top of a built board, both pure, so a keystroke never rereads the
 * store. The gauges in each border keep describing the whole pane.
 */
export function viewBoard(board: Board, view: View): Board {
  const panes = board.panes.map((pane) => {
    const sort = view.sorts[pane.id] ?? 'default'
    const rows = pane.rows.filter((r) => matches(r.project, view.query))
    return {
      ...pane,
      rows: sort === 'default' ? rows : rows.toSorted(COMPARE[sort]),
    }
  })
  return { ...board, panes }
}
