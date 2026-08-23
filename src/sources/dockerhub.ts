import { getJson } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { newestVersion } from './ghcr.ts'
import { Gone, orGone, type Descriptor, type Fetched, type Source } from './types.ts'

const API = 'https://hub.docker.com/v2'
const PAGE = 100
/** Discovery stops here even if `next` keeps answering, so a misbehaving cursor cannot loop. */
const MAX_PAGES = 20

type Repository = {
  name: string
  namespace: string
  is_private: boolean
  star_count: number
  pull_count: number
  last_updated: string | null
}

type Listing<T> = { next: string | null; results: T[] }

function split(name: string): { namespace: string; image: string } {
  const [namespace, image, ...rest] = name.split('/')
  if (!namespace || !image || rest.length) {
    throw new Error(`${name} is not a Docker Hub image, expected "namespace/name"`)
  }
  return { namespace, image }
}

const repoUrl = (namespace: string, image: string) =>
  `${API}/namespaces/${encodeURIComponent(namespace)}/repositories/${encodeURIComponent(image)}`

/**
 * The namespace listing is public and carries every field a fetch needs bar the tags, so
 * one request discovers the portfolio and pays for its counts.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.dockerhub
  if (!account) return []
  const out: Descriptor[] = []
  let url: string | null =
    `${API}/namespaces/${encodeURIComponent(account)}/repositories?page_size=${PAGE}`
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const { data }: { data: Listing<Repository> | null } = await getJson<Listing<Repository>>(url)
    for (const repo of data?.results ?? []) {
      if (repo.is_private) continue
      out.push({
        name: `${repo.namespace}/${repo.name}`.toLowerCase(),
        discovered: 'auto',
        hint: repo,
      })
    }
    url = data?.next ?? null
  }
  return out
}

async function tags(namespace: string, image: string): Promise<string[]> {
  const { data } = await getJson<Listing<{ name: string }>>(
    `${repoUrl(namespace, image)}/tags?page_size=${PAGE}`,
  )
  return (data?.results ?? []).map((tag) => tag.name)
}

/**
 * Docker Hub serves a lifetime pull count and no per-day history, so the rate is the delta
 * between snapshots. It names no source repo either, so the dashboard links it by name.
 */
async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const { namespace, image } = split(descriptor.name)
  let repo = descriptor.fresh ? undefined : (descriptor.hint as Repository | undefined)
  if (!repo) {
    // A private or deleted image answers 404, which is the request that may retire it.
    const { data } = await orGone(getJson<Repository>(repoUrl(namespace, image)))
    if (!data) throw new Error(`no repository data for ${descriptor.name}`)
    if (data.is_private) throw new Gone(`${descriptor.name} is private`)
    repo = data
  }
  const snapshot: Snapshot = {
    id: targetId('dockerhub', descriptor.name),
    ecosystem: 'dockerhub',
    name: descriptor.name,
    url: `https://hub.docker.com/r/${namespace}/${image}`,
    discovered: descriptor.discovered,
    metrics: {
      downloadsTotal: repo.pull_count,
      stars: repo.star_count,
      version: newestVersion(await tags(namespace, image)),
      lastPublish: repo.last_updated,
    },
    links: [],
    fetchedAt: new Date().toISOString(),
  }
  return { snapshot }
}

export const dockerhubSource: Source = {
  ecosystem: 'dockerhub',
  roster: true,
  discover,
  fetch: fetchOne,
}
