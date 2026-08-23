import { loadConfig } from '../core/config.ts'
import type { IssueDetail } from '../sources/github.ts'
import { loadState, readDetail, readSeries } from '../core/store.ts'
import { HEADLINE_METRIC, type SeriesPoint, type Target } from '../core/types.ts'

export type Metric = { value: number; delta: number | null; baselineAt?: string }

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
