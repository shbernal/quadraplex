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
}

type Range = { downloads: { day: string; downloads: number }[] }

function packageUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`
}

/**
 * The search endpoint is authoritative for "packages this account maintains" and already
 * carries version, publish date and the repository link, so discovery pays for itself and
 * the per-package fetch is one downloads request.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.npm
  if (!account) return []
  const out: Descriptor[] = []
  for (let from = 0; ; from += PAGE) {
    const url = `${REGISTRY}/-/v1/search?text=maintainer:${encodeURIComponent(account)}&size=${PAGE}&from=${from}`
    const { data } = await getJson<{ total: number; objects: SearchHit[] }>(url)
    const objects = data?.objects ?? []
    for (const hit of objects) out.push({ name: hit.package.name, discovered: 'auto', hint: hit })
    if (objects.length < PAGE || out.length >= (data?.total ?? 0)) break
  }
  return out
}

/**
 * Only the targeted path needs this. The abbreviated packument is smaller but carries
 * neither publish times nor the repository link, so it would silently drop two metrics.
 */
async function metadata(name: string): Promise<SearchHit['package']> {
  const { data } = await getJson<Packument>(`${REGISTRY}/${encodeURIComponent(name)}`)
  const latest = data?.['dist-tags']?.latest ?? ''
  const repository = typeof data?.repository === 'string' ? data.repository : data?.repository?.url
  const pkg: SearchHit['package'] = {
    name,
    version: latest,
    date: data?.time?.[latest] ?? data?.time?.modified ?? '',
  }
  if (repository) pkg.links = { repository }
  return pkg
}

async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const hint = descriptor.hint as SearchHit | undefined
  const info = hint?.package ?? (await metadata(descriptor.name))

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
