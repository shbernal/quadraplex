import { getJson, postText } from '../core/http.ts'
import { targetId, type SeriesPoint, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import {
  githubRepoFromUrl,
  orGone,
  sumLast,
  type Descriptor,
  type Fetched,
  type Source,
} from './types.ts'

type Warehouse = {
  info: {
    version: string
    summary?: string
    home_page?: string | null
    project_urls?: Record<string, string> | null
  }
  urls?: { upload_time_iso_8601?: string }[]
}

type Overall = {
  data: { category: string; date: string; downloads: number }[]
}

const XMLRPC = 'https://pypi.org/pypi'

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/**
 * Warehouse's JSON API has no packages-by-user endpoint and the profile page sits behind
 * a JavaScript challenge, so the roster is XML-RPC `user_packages`, one of the few methods
 * PyPI kept when it deprecated that API. A fault or an unreadable answer throws, and
 * refresh then falls back to the known targets plus `include`.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.pypi
  if (!account) return []
  const escaped = account.replace(/[&<>]/g, (char) => XML_ESCAPES[char]!)
  const call =
    '<?xml version="1.0"?><methodCall><methodName>user_packages</methodName><params>' +
    `<param><value><string>${escaped}</string></value></param></params></methodCall>`
  const { data } = await postText(XMLRPC, call, 'text/xml')
  const xml = data ?? ''
  const fault = /<name>faultString<\/name>\s*<value>(?:<string>)?([^<]*)/.exec(xml)
  if (fault || xml.includes('<fault>')) {
    throw new Error(`PyPI user_packages failed: ${fault?.[1] ?? 'fault'}`)
  }
  if (!xml.includes('<params>')) throw new Error('PyPI user_packages answered no XML-RPC result')

  // Each entry is a [role, package] pair, and a package can carry both Owner and Maintainer.
  const names = new Set<string>()
  const pair =
    /<array><data>\s*<value>(?:<string>)?[^<]*(?:<\/string>)?<\/value>\s*<value>(?:<string>)?([^<]+?)(?:<\/string>)?<\/value>\s*<\/data><\/array>/g
  for (const match of xml.matchAll(pair)) names.add(match[1]!)
  return [...names].map((name) => ({ name, discovered: 'auto' as const }))
}

/**
 * `project_urls` keys are free text. A key naming the source is trusted before the rest,
 * so a tracker or docs link into some other GitHub repo cannot claim the package.
 */
function repoLink(projectUrls: Record<string, string>, homePage?: string | null): string | null {
  const entries = Object.entries(projectUrls)
  const source = entries.filter(([key]) => /source|repo|code|github/i.test(key))
  const candidates = [...source, ...entries.filter((entry) => !source.includes(entry))].map(
    ([, url]) => url,
  )
  for (const url of [...candidates, homePage]) {
    const repo = githubRepoFromUrl(url)
    if (repo) return repo
  }
  return null
}

async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const name = descriptor.name
  const [meta, stats] = await Promise.all([
    orGone(getJson<Warehouse>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)),
    getJson<Overall>(`https://pypistats.org/api/packages/${encodeURIComponent(name)}/overall`),
  ])

  // The two series arrive interleaved in one array. with_mirrors inflates the number and
  // summing both double counts, so only without_mirrors is ever shown.
  const series: SeriesPoint[] = (stats.data?.data ?? [])
    .filter((point) => point.category === 'without_mirrors')
    .map((point) => ({ date: point.date, downloads: point.downloads }))
    .toSorted((a, b) => a.date.localeCompare(b.date))

  const info = meta.data?.info
  const repo = repoLink(info?.project_urls ?? {}, info?.home_page)
  // Every file of a release is uploaded separately, in no guaranteed order, and the
  // release is out once the last one is.
  const uploads = (meta.data?.urls ?? [])
    .map((file) => file.upload_time_iso_8601)
    .filter((value): value is string => Boolean(value))
    .toSorted()

  const snapshot: Snapshot = {
    id: targetId('pypi', name),
    ecosystem: 'pypi',
    name,
    url: `https://pypi.org/project/${encodeURIComponent(name)}/`,
    discovered: descriptor.discovered,
    metrics: {
      // pypistats answers a package it has no rows for with an empty array, which says
      // nothing about downloads, so it is unknown rather than zero.
      downloadsDay: series.at(-1)?.downloads ?? null,
      downloadsWeek: series.length ? sumLast(series, 7) : null,
      downloadsMonth: series.length ? sumLast(series, 30) : null,
      version: info?.version ?? null,
      lastPublish: uploads.at(-1) ?? null,
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }

  const fetched: Fetched = { snapshot, series }
  if (info?.summary) fetched.detail = { description: info.summary }
  return fetched
}

export const pypiSource: Source = {
  ecosystem: 'pypi',
  roster: true,
  discover,
  fetch: fetchOne,
}
