import { getJson } from '../core/http.ts'
import { targetId, type SeriesPoint, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { githubRepoFromUrl, sumLast, type Descriptor, type Fetched, type Source } from './types.ts'

const REGISTRY = 'https://registry.npmjs.org'
const DOWNLOADS = 'https://api.npmjs.org/downloads'
const PAGE = 250

type SearchHit = {
  package: {
    name: string
    version: string
    description?: string
    date: string
    links?: { repository?: string; homepage?: string; npm?: string }
  }
}

type Packument = {
  'dist-tags': { latest?: string }
  time?: Record<string, string>
  repository?: { url?: string } | string
  homepage?: string
  versions?: Record<string, { deprecated?: string }>
}

type Range = { downloads: { day: string; downloads: number }[] }

/** What a fetch needs to know about a package, from whichever endpoint could answer. */
type Info = SearchHit['package'] & { deprecated: boolean }

function packageUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`
}

/**
 * The search index carries version, publish date and the repository link, so a hit pays
 * for the whole per-package fetch bar the downloads request. It is not a roster though:
 * npm drops deprecated packages from search, which is silent both ways round, hiding a
 * package that was deprecated before it was ever seen and freezing one that was
 * deprecated after.
 */
async function search(account: string): Promise<Map<string, SearchHit>> {
  const hits = new Map<string, SearchHit>()
  for (let from = 0; ; from += PAGE) {
    const url = `${REGISTRY}/-/v1/search?text=maintainer:${encodeURIComponent(account)}&size=${PAGE}&from=${from}`
    const { data } = await getJson<{ total: number; objects: SearchHit[] }>(url)
    const objects = data?.objects ?? []
    for (const hit of objects) hits.set(hit.package.name, hit)
    if (objects.length < PAGE || hits.size >= (data?.total ?? 0)) break
  }
  return hits
}

/**
 * The list `npm access list packages` prints, which is the roster search cannot be. It is
 * public and unauthenticated, but it is also a legacy endpoint, so a failure degrades to
 * whatever search found rather than emptying the portfolio.
 */
async function roster(account: string): Promise<string[]> {
  try {
    const url = `${REGISTRY}/-/user/${encodeURIComponent(account)}/package`
    const { data } = await getJson<Record<string, string>>(url)
    return Object.keys(data ?? {})
  } catch {
    return []
  }
}

async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.npm
  if (!account) return []
  const [hints, owned] = await Promise.all([search(account), roster(account)])
  const names = new Set([...hints.keys(), ...owned])
  return [...names].map((name) => {
    const hint = hints.get(name)
    return hint
      ? { name, discovered: 'auto' as const, hint }
      : { name, discovered: 'auto' as const }
  })
}

/**
 * The path for everything search did not hand over. The abbreviated packument is smaller
 * but carries neither publish times nor the repository link nor deprecation, so it would
 * silently drop three metrics.
 */
async function metadata(name: string): Promise<Info> {
  const { data } = await getJson<Packument>(`${REGISTRY}/${encodeURIComponent(name)}`)
  const latest = data?.['dist-tags']?.latest ?? ''
  const repository = typeof data?.repository === 'string' ? data.repository : data?.repository?.url
  const info: Info = {
    name,
    version: latest,
    date: data?.time?.[latest] ?? data?.time?.modified ?? '',
    // Deprecation is a property of a version, not of the package, so the question is
    // whether the version people install carries the notice.
    deprecated: typeof data?.versions?.[latest]?.deprecated === 'string',
  }
  if (repository) info.links = { repository }
  return info
}

async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const hint = descriptor.hint as SearchHit | undefined
  // Search excluding deprecated packages is what makes a hit an answer here: a package
  // the index still returns is one npm considers current.
  const info: Info = hint ? { ...hint.package, deprecated: false } : await metadata(descriptor.name)

  const encoded = encodeURIComponent(descriptor.name)
  const { data } = await getJson<Range>(`${DOWNLOADS}/range/last-year/${encoded}`)
  const series: SeriesPoint[] = (data?.downloads ?? []).map((point) => ({
    date: point.day,
    downloads: point.downloads,
  }))

  const repo = githubRepoFromUrl(info.links?.repository ?? info.links?.homepage)
  const snapshot: Snapshot = {
    id: targetId('npm', descriptor.name),
    ecosystem: 'npm',
    name: descriptor.name,
    url: packageUrl(descriptor.name),
    discovered: descriptor.discovered,
    metrics: {
      downloadsDay: series.at(-1)?.downloads ?? 0,
      downloadsWeek: sumLast(series, 7),
      downloadsMonth: sumLast(series, 30),
      version: info.version || null,
      lastPublish: info.date || null,
      deprecated: info.deprecated ? 'yes' : 'no',
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }

  const fetched: Fetched = { snapshot, series }
  if (info.description) fetched.detail = { description: info.description }
  return fetched
}

export const npmSource: Source = {
  ecosystem: 'npm',
  discover,
  fetch: fetchOne,
}
