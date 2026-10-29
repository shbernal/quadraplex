import { getJson } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { Gone, githubRepoFromUrl, type Descriptor, type Fetched, type Source } from './types.ts'

const INDEX = 'https://api.nuget.org/v3/index.json'
const PAGE = 1000
/** Discovery stops here even if the hit count keeps promising more. */
const MAX_PAGES = 5
/** What an unlisted version's registration leaf reports as its publish time. */
const UNLISTED_YEAR = '1900'

type Hit = {
  id: string
  projectUrl?: string | null
  description?: string
  owners: string[] | string
  totalDownloads: number
  verified: boolean
  /** Every listed version, oldest first, each linking its registration leaf. */
  versions: { version: string; '@id': string }[]
}

type Search = { totalHits: number; data: Hit[] }

/** The search service's address comes from the v3 service index, as NuGet clients find it. */
async function searchUrl(): Promise<string> {
  const { data } = await getJson<{ resources: { '@id': string; '@type': string }[] }>(INDEX)
  const service = data?.resources.find((r) => r['@type'].startsWith('SearchQueryService'))
  if (!service) throw new Error('the NuGet service index names no search service')
  return service['@id']
}

const search = async (query: string, skip = 0) =>
  (
    await getJson<Search>(
      `${await searchUrl()}?q=${encodeURIComponent(query)}&prerelease=true&semVerLevel=2.0.0&take=${PAGE}&skip=${skip}`,
    )
  ).data

const owners = (hit: Hit) => (Array.isArray(hit.owners) ? hit.owners : [hit.owners])

/**
 * Search is the only owner listing NuGet serves, and it leaves out unlisted packages, so
 * it is not a roster: a known package missing from it is fetched before anything retires.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.nuget
  if (!account) return []
  const out: Descriptor[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await search(`owner:${account}`, page * PAGE)
    if (!result) throw new Error('NuGet search answered nothing')
    for (const hit of result.data) {
      out.push({ name: hit.id.toLowerCase(), discovered: 'auto', hint: hit })
    }
    if (result.data.length < PAGE || out.length >= result.totalHits) break
  }
  return out
}

/** The highest listed version without a prerelease part, else the highest of all. */
function newest(versions: Hit['versions']): string | null {
  const stable = versions.filter((v) => !v.version.includes('-'))
  return (stable.at(-1) ?? versions.at(-1))?.version ?? null
}

/**
 * NuGet serves a lifetime download count and no per-day history, so the rate is the delta
 * between snapshots. The publish time is on the newest version's registration leaf.
 */
async function fetchOne(descriptor: Descriptor, config: Config): Promise<Fetched> {
  // IDs are case-insensitive, so a name typed in any case lands on the discovered target.
  const name = descriptor.name.toLowerCase()
  let hit = descriptor.fresh ? undefined : (descriptor.hint as Hit | undefined)
  if (!hit) {
    const result = await search(`packageid:${name}`)
    hit = result?.data.find((h) => h.id.toLowerCase() === name)
    // Deleting is rare on NuGet; unlisting is how a package is withdrawn, and search hides it.
    if (!hit) throw new Gone(`${name} is not listed on NuGet`)
  }
  const account = config.accounts.nuget
  const by = owners(hit)
  const mine = !account || by.some((o) => o.toLowerCase() === account.toLowerCase())
  if (descriptor.discovered === 'auto' && !mine) {
    throw new Gone(`now owned by ${by.join(', ')}`)
  }

  const leaf = hit.versions.at(-1)?.['@id']
  const published = leaf ? (await getJson<{ published?: string }>(leaf)).data?.published : null
  const repo = githubRepoFromUrl(hit.projectUrl)
  const snapshot: Snapshot = {
    id: targetId('nuget', name),
    ecosystem: 'nuget',
    name,
    url: `https://www.nuget.org/packages/${hit.id}`,
    discovered: descriptor.discovered,
    metrics: {
      downloadsTotal: hit.totalDownloads,
      version: newest(hit.versions),
      lastPublish: published && !published.startsWith(UNLISTED_YEAR) ? published : null,
      verified: hit.verified ? 'yes' : 'no',
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }
  const fetched: Fetched = { snapshot }
  if (hit.description) fetched.detail = { description: hit.description }
  return fetched
}

export const nugetSource: Source = {
  ecosystem: 'nuget',
  roster: false,
  discover,
  fetch: fetchOne,
}
