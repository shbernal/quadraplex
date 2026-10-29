import { getJson } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import {
  Gone,
  githubRepoFromUrl,
  orGone,
  type Descriptor,
  type Fetched,
  type Source,
} from './types.ts'

const API = 'https://rubygems.org/api/v1'

/** The same shape answers the owner listing and a single gem. */
type Gem = {
  name: string
  downloads: number
  version: string
  version_created_at: string | null
  version_downloads: number
  info?: string | null
  yanked: boolean
  homepage_uri?: string | null
  source_code_uri?: string | null
}

/**
 * The owner listing is one unpaginated request carrying every field a fetch needs, so
 * discovery pays for the counts. A gem whose versions were all yanked stays in the listing,
 * flagged, and is left out so that it retires like an unpublished package.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.rubygems
  if (!account) return []
  const { data } = await getJson<Gem[]>(`${API}/owners/${encodeURIComponent(account)}/gems.json`)
  return (data ?? [])
    .filter((gem) => !gem.yanked)
    .map((gem) => ({ name: gem.name, discovered: 'auto' as const, hint: gem }))
}

/**
 * RubyGems serves lifetime counts and no per-day history, so the rate is the delta between
 * snapshots, as on Docker Hub.
 */
async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const name = descriptor.name
  let gem = descriptor.fresh ? undefined : (descriptor.hint as Gem | undefined)
  if (!gem) {
    const { data } = await orGone(getJson<Gem>(`${API}/gems/${encodeURIComponent(name)}.json`))
    if (!data) throw new Error(`no gem data for ${name}`)
    if (data.yanked) throw new Gone(`${name} is yanked`)
    gem = data
  }
  const repo = githubRepoFromUrl(gem.source_code_uri) ?? githubRepoFromUrl(gem.homepage_uri)
  const snapshot: Snapshot = {
    id: targetId('rubygems', name),
    ecosystem: 'rubygems',
    name,
    url: `https://rubygems.org/gems/${encodeURIComponent(name)}`,
    discovered: descriptor.discovered,
    metrics: {
      downloadsTotal: gem.downloads,
      downloadsVersion: gem.version_downloads,
      version: gem.version,
      lastPublish: gem.version_created_at,
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }
  const fetched: Fetched = { snapshot }
  if (gem.info) fetched.detail = { description: gem.info.trim() }
  return fetched
}

export const rubygemsSource: Source = {
  ecosystem: 'rubygems',
  roster: true,
  discover,
  fetch: fetchOne,
}
