import { loadConfig } from '../core/config.ts'
import { loadState, readSeries } from '../core/store.ts'
import { HEADLINE_METRIC, type SeriesPoint, type Target } from '../core/types.ts'

export type Project = {
  key: string
  name: string
  targets: Target[]
  changed: boolean
  stale: boolean
  /** The npm or PyPI series that drives the row's sparkline, empty when there is none. */
  series: SeriesPoint[]
  downloads: { value: number; delta: number | null; baselineAt?: string } | null
  stars: { value: number; delta: number | null; baselineAt?: string } | null
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

function metric(target: Target | undefined, key: string) {
  if (!target) return null
  const value = target.metrics[key]
  if (typeof value !== 'number') return null
  const out: { value: number; delta: number | null; baselineAt?: string } = {
    value,
    delta: target.deltas ? (target.deltas[key] ?? null) : null,
  }
  if (target.deltaBaselineAt) out.baselineAt = target.deltaBaselineAt
  return out
}

/**
 * Your own scope is noise, someone else's is the only thing telling `@injectlab/cli`
 * apart from every other package called cli, so only the configured account is stripped.
 */
function displayName(targets: Target[], ownScope: string | undefined): string {
  const repo = targets.find((t) => t.ecosystem === 'github')
  if (repo) return repo.name.split('/').at(-1)!
  const name = targets[0]!.name
  if (ownScope && name.startsWith(`@${ownScope}/`)) return name.slice(ownScope.length + 2)
  return name.replace(/^@/, '')
}

export function buildProjects(): Project[] {
  const config = loadConfig()
  const state = loadState(config)
  const projects = group(state.targets).map((targets): Project => {
    const ordered = targets.toSorted((a, b) => a.ecosystem.localeCompare(b.ecosystem))
    const registry = ordered.find((t) => t.ecosystem === 'npm' || t.ecosystem === 'pypi')
    const repo = ordered.find((t) => t.ecosystem === 'github')
    return {
      key: ordered.map((t) => t.id).join('+'),
      name: displayName(ordered, config.accounts.npm),
      targets: ordered,
      changed: ordered.some((t) =>
        t.deltas ? Object.values(t.deltas).some((d) => d !== null && d !== 0) : false,
      ),
      stale: ordered.some((t) => t.stale),
      series: registry ? readSeries(registry.id) : [],
      downloads: metric(registry, HEADLINE_METRIC.npm),
      stars: metric(repo, HEADLINE_METRIC.github),
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

export function browserUrl(target: Target): string {
  return target.url
}
