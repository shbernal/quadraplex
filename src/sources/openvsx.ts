import { getJson } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { githubRepoFromUrl, orGone, type Descriptor, type Fetched, type Source } from './types.ts'

const API = 'https://open-vsx.org/api'

type Namespace = { name: string; extensions: Record<string, string> }

type Extension = {
  namespace: string
  name: string
  displayName?: string
  version: string
  timestamp: string
  downloadCount: number
  /** Absent until the first review. */
  averageRating?: number
  reviewCount: number
  deprecated?: boolean
  repository?: string
  homepage?: string
  bugs?: string
}

function split(name: string): { namespace: string; extension: string } {
  const dot = name.indexOf('.')
  if (dot < 1 || dot === name.length - 1) {
    throw new Error(`${name} is not an Open VSX extension, expected "namespace.name"`)
  }
  return { namespace: name.slice(0, dot), extension: name.slice(dot + 1) }
}

/**
 * The namespace endpoint lists every active extension by name and nothing else, so it is
 * the roster and each extension costs its own request. Search takes a namespace parameter
 * but ignores it.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.openvsx
  if (!account) return []
  const { data } = await getJson<Namespace>(`${API}/${encodeURIComponent(account)}`)
  return Object.keys(data?.extensions ?? {}).map((extension) => ({
    name: `${account}.${extension}`.toLowerCase(),
    discovered: 'auto',
  }))
}

/**
 * `downloadCount` is a lifetime total over every version and platform, with no per-day
 * history, so the rate is the delta between snapshots.
 */
async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const { namespace, extension } = split(descriptor.name)
  const url = `${API}/${encodeURIComponent(namespace)}/${encodeURIComponent(extension)}`
  const { data } = await orGone(getJson<Extension>(url))
  if (!data) throw new Error(`no extension data for ${descriptor.name}`)
  const repo = githubRepoFromUrl(data.repository ?? data.homepage ?? data.bugs)
  const name = `${data.namespace}.${data.name}`.toLowerCase()
  const snapshot: Snapshot = {
    id: targetId('openvsx', name),
    ecosystem: 'openvsx',
    name,
    url: `https://open-vsx.org/extension/${data.namespace}/${data.name}`,
    discovered: descriptor.discovered,
    metrics: {
      downloadsTotal: data.downloadCount,
      rating:
        data.reviewCount && data.averageRating !== undefined
          ? Math.round(data.averageRating * 100) / 100
          : null,
      ratings: data.reviewCount,
      version: data.version,
      lastPublish: data.timestamp,
      deprecated: data.deprecated ? 'yes' : 'no',
      title: data.displayName || null,
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }
  return { snapshot }
}

export const openvsxSource: Source = {
  ecosystem: 'openvsx',
  roster: true,
  discover,
  fetch: fetchOne,
}
