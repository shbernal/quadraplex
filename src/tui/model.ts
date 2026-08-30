import { loadConfig } from '../core/config.ts'
import { compactNumber } from '../core/format.ts'
import type { IssueDetail } from '../sources/github.ts'
import { loadState, readCurve, readDetail, readSeries } from '../core/store.ts'
import {
  HEADLINE_METRIC,
  type Ecosystem,
  type SeriesPoint,
  type Stargazer,
  type Target,
} from '../core/types.ts'

export type Metric = { value: number; delta: number | null; baselineAt?: string }

/**
 * One store's reading of a user count, never summed with another's. A Chrome install
 * bucket and a Firefox daily-user count do not share a unit, so the row shows one reading
 * and names the store it came from. The detail pane lists every store.
 */
export type Reach = { label: string; source: Ecosystem; bucket: boolean; delta: number | null }

/** A score and the number of ratings behind it, from whichever store has the most. */
export type Rating = { score: number; count: number; source: Ecosystem }

export type Project = {
  key: string
  name: string
  targets: Target[]
  changed: boolean
  stale: boolean
  /** Per-day history behind the row's sparkline, empty when no source serves one. */
  series: SeriesPoint[]
  downloads: Metric | null
  stars: Metric | null
  /** Extension reach, from the Chrome bucket when there is one and Firefox otherwise. */
  reach: Reach | null
  rating: Rating | null
}

/**
 * A package and its repo are one project to a human, so rows are built from the `links`
 * field rather than one per artifact. Links are treated as undirected: npm names its
 * repo, the repo does not name the package, and either direction should group them.
 */
function group(targets: Target[]): Target[][] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const seen = parent.get(id)
    if (seen === undefined || seen === id) return id
    const root = find(seen)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)]
    if (ra !== rb) parent.set(rb, ra)
  }

  const known = new Set(targets.map((t) => t.id))
  for (const target of targets) {
    parent.set(target.id, parent.get(target.id) ?? target.id)
    for (const link of target.links) if (known.has(link)) union(target.id, link)
  }

  const groups = new Map<string, Target[]>()
  for (const target of targets) {
    const root = find(target.id)
    const list = groups.get(root)
    if (list) list.push(target)
    else groups.set(root, [target])
  }
  return [...groups.values()]
}

/**
 * A monorepo publishes several packages from one repo, so a project's headline number is
 * the sum across its distribution targets. A delta is only meaningful when every contributing
 * target has a baseline, otherwise the sum would silently drop the ones that do not.
 */
function metric(targets: Target[], key: string): Metric | null {
  const relevant = targets.filter((t) => typeof t.metrics[key] === 'number')
  if (relevant.length === 0) return null
  const value = relevant.reduce((total, t) => total + (t.metrics[key] as number), 0)
  const deltas = relevant.map((t) => (t.deltas ? (t.deltas[key] ?? null) : null))
  const out: Metric = {
    value,
    delta: deltas.includes(null) ? null : deltas.reduce((total, d) => total! + d!, 0),
  }
  const baseline = relevant.find((t) => t.deltaBaselineAt)?.deltaBaselineAt
  if (baseline) out.baselineAt = baseline
  return out
}

/**
 * Chrome first because an install bucket is the wider reading and Google publishes
 * nothing finer, then Firefox daily users. The badge in the same row already says which
 * stores a project is on, so naming the source here costs one letter and no ambiguity.
 */
function reach(targets: Target[]): Reach | null {
  const chrome = targets.find((t) => t.ecosystem === 'cws' && typeof t.metrics.users === 'string')
  // Google's label is kept verbatim. Reformatting "1,000" as a number would be the first
  // step towards subtracting two of them, which measures the bucket boundary moving.
  if (chrome) {
    return { label: chrome.metrics.users as string, source: 'cws', bucket: true, delta: null }
  }
  const firefox = targets.find((t) => t.ecosystem === 'amo' && typeof t.metrics.users === 'number')
  if (!firefox) return null
  return {
    label: compactNumber(firefox.metrics.users as number),
    source: 'amo',
    bucket: false,
    delta: firefox.deltas ? (firefox.deltas.users ?? null) : null,
  }
}

/** The best evidenced score wins, because an average over one rating is not a score. */
function rating(targets: Target[]): Rating | null {
  const rated = targets
    .filter((t) => typeof t.metrics.rating === 'number' && typeof t.metrics.ratings === 'number')
    .toSorted((a, b) => (b.metrics.ratings as number) - (a.metrics.ratings as number))
  const best = rated[0]
  if (!best || (best.metrics.ratings as number) === 0) return null
  return {
    score: best.metrics.rating as number,
    count: best.metrics.ratings as number,
    source: best.ecosystem,
  }
}

/** Element-wise sum by date, so a multi-package project gets one honest trace. */
function mergeSeries(all: SeriesPoint[][]): SeriesPoint[] {
  if (all.length <= 1) return all[0] ?? []
  const totals = new Map<string, number>()
  for (const series of all) {
    for (const point of series)
      totals.set(point.date, (totals.get(point.date) ?? 0) + point.downloads)
  }
  return [...totals.entries()]
    .map(([date, downloads]) => ({ date, downloads }))
    .toSorted((a, b) => a.date.localeCompare(b.date))
}

/**
 * Your own scope is noise, someone else's is the only thing telling `@injectlab/cli`
 * apart from every other package called cli, so only the configured account is stripped.
 */
function displayName(targets: Target[], ownScope: string | undefined): string {
  const repo = targets.find((t) => t.ecosystem === 'github')
  if (repo) return repo.name.split('/').at(-1)!
  // A Chrome extension is identified by an opaque 32 letter id, so an unlinked one falls
  // back to the title its listing carries.
  const titled = targets.find((t) => typeof t.metrics.title === 'string')
  if (titled) return titled.metrics.title as string
  const name = targets[0]!.name
  if (ownScope && name.startsWith(`@${ownScope}/`)) return name.slice(ownScope.length + 2)
  return name.replace(/^@/, '')
}

export function buildProjects(): Project[] {
  const config = loadConfig()
  const state = loadState(config)
  const projects = group(state.targets).map((targets): Project => {
    const ordered = targets.toSorted((a, b) => a.ecosystem.localeCompare(b.ecosystem))
    // Anything that is not a repo can report downloads. Only the registries serve a
    // per-day history, so AMO adds to the number without adding to the trace.
    const distributions = ordered.filter((t) => t.ecosystem !== 'github')
    const repos = ordered.filter((t) => t.ecosystem === 'github')
    return {
      key: ordered.map((t) => t.id).join('+'),
      name: displayName(ordered, config.accounts.npm),
      targets: ordered,
      changed: ordered.some((t) =>
        t.deltas ? Object.values(t.deltas).some((d) => d !== null && d !== 0) : false,
      ),
      stale: ordered.some((t) => t.stale),
      series: mergeSeries(distributions.map((t) => readSeries(t.id))),
      downloads: metric(distributions, HEADLINE_METRIC.npm),
      stars: metric(repos, HEADLINE_METRIC.github),
      reach: reach(ordered),
      rating: rating(ordered),
    }
  })

  // A quiet portfolio should look quiet. What moved is what draws the eye, so changed
  // rows lead, then anything with no baseline yet, then the rest alphabetically.
  return projects.toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

function rank(project: Project): number {
  if (project.changed) return 0
  return project.downloads?.delta === null ? 1 : 2
}

/** The roster, plus the weakest freshness claim it is allowed to make. */
export type Stargazers = { people: Stargazer[]; asOf: string }

/**
 * Who starred, read from the curves `refresh --curves` leaves on disk rather than
 * fetched. A project spanning several repos reports the oldest of their curves, so the
 * age shown is the one the whole roster can stand behind.
 */
export function projectStargazers(project: Project): Stargazers | null {
  const byLogin = new Map<string, Stargazer>()
  let asOf = ''
  for (const target of project.targets) {
    if (target.ecosystem !== 'github') continue
    const curve = readCurve(target.id)
    if (!curve?.stargazers) continue
    if (!asOf || curve.fetchedAt < asOf) asOf = curve.fetchedAt
    for (const person of curve.stargazers) {
      const seen = byLogin.get(person.login)
      if (!seen || person.starredAt > seen.starredAt) byLogin.set(person.login, person)
    }
  }
  if (byLogin.size === 0) return null
  return {
    people: [...byLogin.values()].toSorted((a, b) => b.starredAt.localeCompare(a.starredAt)),
    asOf,
  }
}

/** A repo with stars but no harvested roster is waiting on a curve nobody has built. */
export function awaitingCurves(project: Project): boolean {
  return project.targets.some((target) => {
    const stars = target.metrics.stars
    if (target.ecosystem !== 'github' || typeof stars !== 'number' || stars === 0) return false
    return readCurve(target.id)?.stargazers === undefined
  })
}

/**
 * Open issues and pull requests are written to disk by refresh, so the modal reads them
 * from the store like everything else. The dashboard never fetches.
 */
export function projectItems(project: Project): IssueDetail[] {
  return project.targets
    .filter((target) => target.ecosystem === 'github')
    .flatMap((target) => (readDetail(target.id) as { items?: IssueDetail[] } | null)?.items ?? [])
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** What the detail cursor can land on, in the order the pane draws it. */
export type Focus =
  | { kind: 'target'; url: string; target: Target }
  | { kind: 'item'; url: string; item: IssueDetail }

export function focusables(project: Project, items: IssueDetail[]): Focus[] {
  return [
    ...project.targets.map((target) => ({ kind: 'target' as const, url: target.url, target })),
    ...items.map((item) => ({ kind: 'item' as const, url: item.url, item })),
  ]
}

/**
 * Which page "o" opens from the list, where there is no cursor to ask. The repo is a
 * project's home when it has one, and ordering the rest by how much they say about it
 * beats the alphabetical accident of the target list.
 */
const HOME_ORDER: Ecosystem[] = ['github', 'npm', 'pypi', 'amo', 'cws']

export function homeUrl(project: Project): string {
  for (const ecosystem of HOME_ORDER) {
    const target = project.targets.find((t) => t.ecosystem === ecosystem)
    if (target) return target.url
  }
  return project.targets[0]!.url
}
