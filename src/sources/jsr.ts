import { getJson } from '../core/http.ts'
import { targetId, type SeriesPoint, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { orGone, sumLast, type Descriptor, type Fetched, type Source } from './types.ts'

const API = 'https://api.jsr.io'
const PAGE = 100
/** Discovery stops here even if `total` keeps promising more, so a bad count cannot loop. */
const MAX_PAGES = 20
/** How far back the downloads endpoint answers, today included. */
const WINDOW_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

type Package = {
  scope: string
  name: string
  description: string
  githubRepository: { owner: string; name: string } | null
  runtimeCompat: Partial<Record<string, boolean>>
  dependentCount: number
  score: number | null
  latestVersion: string | null
  isArchived: boolean
}

type Version = { version: string; yanked: boolean; createdAt: string }

/** One day's count of one kind of download, `jsr_meta` or `npm_tarball`, zero days absent. */
type Bucket = { timeBucket: string; kind: string; count: number }

function split(name: string): { scope: string; pkg: string } {
  const match = /^@([^/]+)\/([^/]+)$/.exec(name)
  if (!match) throw new Error(`${name} is not a JSR package, expected "@scope/name"`)
  return { scope: match[1]!, pkg: match[2]! }
}

const packageUrl = (scope: string, pkg: string) =>
  `${API}/scopes/${encodeURIComponent(scope)}/packages/${encodeURIComponent(pkg)}`

/**
 * JSR users are GitHub-linked but keyed by an opaque id the public API cannot look up by
 * login, so the account is a scope. Its listing is the roster and carries every field a
 * fetch needs bar the downloads and the release date.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const scope = config.accounts.jsr
  if (!scope) return []
  const out: Descriptor[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await getJson<{ items: Package[]; total: number }>(
      `${API}/scopes/${encodeURIComponent(scope)}/packages?limit=${PAGE}&page=${page}`,
    )
    const items = data?.items ?? []
    for (const hint of items) {
      out.push({ name: `@${hint.scope}/${hint.name}`, discovered: 'auto', hint })
    }
    if (items.length < PAGE || out.length >= (data?.total ?? 0)) break
  }
  return out
}

/**
 * JSR counts registry metadata reads and npm compatibility tarballs per day and leaves out
 * the days with none. Both kinds are installs, so they are summed, and the window is filled
 * with zeros up to yesterday: today's bucket is still counting.
 */
function toSeries(buckets: Bucket[], now = Date.now()): SeriesPoint[] {
  const byDay = new Map<string, number>()
  for (const b of buckets) {
    const day = b.timeBucket.slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + b.count)
  }
  const today = Date.parse(new Date(now).toISOString().slice(0, 10))
  const series: SeriesPoint[] = []
  for (let back = WINDOW_DAYS - 1; back >= 1; back--) {
    const date = new Date(today - back * DAY_MS).toISOString().slice(0, 10)
    series.push({ date, downloads: byDay.get(date) ?? 0 })
  }
  return series
}

/** The runtimes a package declares, in a fixed order, or null when it declares none. */
function runtimes(compat: Package['runtimeCompat']): string | null {
  const names = Object.keys(compat)
    .filter((k) => compat[k])
    .toSorted()
  return names.length ? names.join(',') : null
}

async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const { scope, pkg } = split(descriptor.name)
  let info = descriptor.fresh ? undefined : (descriptor.hint as Package | undefined)
  if (!info) {
    // A deleted package answers 404, which is the request that may retire it.
    const { data } = await orGone(getJson<Package>(packageUrl(scope, pkg)))
    if (!data) throw new Error(`no package data for ${descriptor.name}`)
    info = data
  }
  const latest = info.latestVersion
  const [downloads, version] = await Promise.all([
    getJson<{ total: Bucket[] }>(`${packageUrl(scope, pkg)}/downloads`),
    latest
      ? getJson<Version>(`${packageUrl(scope, pkg)}/versions/${encodeURIComponent(latest)}`)
      : null,
  ])
  const series = toSeries(downloads.data?.total ?? [])
  const repo = info.githubRepository
  const snapshot: Snapshot = {
    id: targetId('jsr', descriptor.name),
    ecosystem: 'jsr',
    name: descriptor.name,
    url: `https://jsr.io/${descriptor.name}`,
    discovered: descriptor.discovered,
    metrics: {
      downloadsDay: series.at(-1)!.downloads,
      downloadsWeek: sumLast(series, 7),
      downloadsMonth: sumLast(series, 30),
      version: latest,
      lastPublish: version?.data?.createdAt ?? null,
      score: info.score,
      runtimes: runtimes(info.runtimeCompat),
      dependents: info.dependentCount,
      archived: info.isArchived ? 'yes' : 'no',
    },
    links: repo ? [targetId('github', `${repo.owner}/${repo.name}`)] : [],
    fetchedAt: new Date().toISOString(),
  }
  const fetched: Fetched = { snapshot, series }
  if (info.description) fetched.detail = { description: info.description }
  return fetched
}

export const jsrSource: Source = {
  ecosystem: 'jsr',
  roster: true,
  discover,
  fetch: fetchOne,
}
