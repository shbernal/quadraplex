import { getJson, HttpError } from '../core/http.ts'
import { targetId, type SeriesPoint, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import {
  githubRepoFromUrl,
  orGone,
  PartialDiscovery,
  sumLast,
  type Descriptor,
  type Fetched,
  type Source,
} from './types.ts'

const REGISTRY = 'https://registry.npmjs.org'
const DOWNLOADS = 'https://api.npmjs.org/downloads'
const VERSIONS = 'https://api.npmjs.org/versions'
const PAGE = 250
/** The most packages npm's downloads API answers in one bulk request. */
const BULK = 128

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

/** What discovery already paid for. A `downloads` of null is an answer: no stats yet. */
type Hint = { search?: SearchHit; downloads?: SeriesPoint[] | null }

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
 * whatever search found, flagged partial so nothing is retired for missing from it.
 */
async function roster(account: string): Promise<string[]> {
  const url = `${REGISTRY}/-/user/${encodeURIComponent(account)}/package`
  const { data } = await getJson<Record<string, string>>(url)
  return Object.keys(data ?? {})
}

function toSeries(range: Range): SeriesPoint[] {
  return range.downloads.map((point) => ({ date: point.day, downloads: point.downloads }))
}

/**
 * The downloads API rate limits by request, and one bulk request answers up to 128
 * unscoped packages, so a portfolio pays per scoped package only: bulk refuses scopes.
 * Bulk is an optimisation, so a failure leaves each package to its own request.
 */
async function bulkDownloads(names: string[]): Promise<Map<string, SeriesPoint[] | null>> {
  const answered = new Map<string, SeriesPoint[] | null>()
  const unscoped = names.filter((name) => !name.startsWith('@'))
  // A single name gets the single package shape back, not a map.
  if (unscoped.length < 2) return answered
  for (let start = 0; start < unscoped.length; start += BULK) {
    const chunk = unscoped.slice(start, start + BULK)
    const url = `${DOWNLOADS}/range/last-year/${chunk.map(encodeURIComponent).join(',')}`
    const { data } = await getJson<Record<string, Range | null>>(url).catch(() => ({ data: null }))
    for (const name of chunk) {
      const range = data?.[name]
      if (range !== undefined) answered.set(name, range ? toSeries(range) : null)
    }
  }
  return answered
}

async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.npm
  if (!account) return []
  const [hints, owned] = await Promise.all([
    search(account),
    roster(account).catch((error: unknown) => ({ error })),
  ])
  const names = [...new Set([...hints.keys(), ...(Array.isArray(owned) ? owned : [])])]
  const counts = await bulkDownloads(names)
  const found = names.map((name) => {
    const hint: Hint = {}
    const hit = hints.get(name)
    if (hit) hint.search = hit
    if (counts.has(name)) hint.downloads = counts.get(name)!
    return { name, discovered: 'auto' as const, hint }
  })
  if (!Array.isArray(owned)) {
    throw new PartialDiscovery(found, 'npm roster unreadable, search only', { cause: owned.error })
  }
  return found
}

/**
 * The path for everything search did not hand over. The abbreviated packument is smaller
 * but carries neither publish times nor the repository link nor deprecation, so it would
 * silently drop three metrics.
 */
async function metadata(name: string): Promise<Info> {
  const { data } = await orGone(getJson<Packument>(`${REGISTRY}/${encodeURIComponent(name)}`))
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

/**
 * Null when the stats service has no record of a package the registry has, which is how
 * it answers for one published within the last day or so: unknown, not zero downloads.
 */
async function downloads(name: string): Promise<SeriesPoint[] | null> {
  try {
    const { data } = await getJson<Range>(
      `${DOWNLOADS}/range/last-year/${encodeURIComponent(name)}`,
    )
    return data ? toSeries(data) : []
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null
    throw error
  }
}

/**
 * The registry only keeps the current week of this split, so a missed reading is gone for
 * good. It is a breakdown of a count the snapshot already has, so a failure costs the
 * breakdown and never the target.
 */
async function versions(name: string): Promise<Record<string, number> | undefined> {
  try {
    const { data } = await getJson<{ downloads: Record<string, number> }>(
      `${VERSIONS}/${encodeURIComponent(name)}/last-week`,
    )
    if (!data) return undefined
    return Object.fromEntries(Object.entries(data.downloads).filter(([, count]) => count > 0))
  } catch {
    return undefined
  }
}

async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const hint = (descriptor.hint ?? {}) as Hint
  // Search excluding deprecated packages is what makes a hit an answer here: a package
  // the index still returns is one npm considers current.
  const [info, series] = await Promise.all([
    hint.search ? { ...hint.search.package, deprecated: false } : metadata(descriptor.name),
    hint.downloads !== undefined ? hint.downloads : downloads(descriptor.name),
  ])

  const week = series ? sumLast(series, 7) : null
  const split = week ? await versions(descriptor.name) : undefined

  const repo = githubRepoFromUrl(info.links?.repository ?? info.links?.homepage)
  const snapshot: Snapshot = {
    id: targetId('npm', descriptor.name),
    ecosystem: 'npm',
    name: descriptor.name,
    url: packageUrl(descriptor.name),
    discovered: descriptor.discovered,
    metrics: {
      downloadsDay: series ? (series.at(-1)?.downloads ?? 0) : null,
      downloadsWeek: week,
      downloadsMonth: series ? sumLast(series, 30) : null,
      version: info.version || null,
      lastPublish: info.date || null,
      deprecated: info.deprecated ? 'yes' : 'no',
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }
  if (split) snapshot.versions = split

  const fetched: Fetched = { snapshot }
  if (series) fetched.series = series
  if (info.description) fetched.detail = { description: info.description }
  return fetched
}

export const npmSource: Source = {
  ecosystem: 'npm',
  roster: true,
  discover,
  fetch: fetchOne,
}
