import { getJson } from '../core/http.ts'
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

const API = 'https://packagist.org'
const DAY = 86_400_000

type Version = { version: string; version_normalized: string; time: string | null }

type Package = {
  package: {
    name: string
    description?: string
    repository?: string | null
    abandoned?: boolean | string
    dependents?: number
    favers?: number
    downloads?: { total: number; monthly: number; daily: number }
    versions?: Record<string, Version>
  }
}

type Stats = { labels: string[]; values: Record<string, number[]> }

function split(name: string): { vendor: string; pkg: string } {
  const [vendor, pkg, ...rest] = name.split('/')
  if (!vendor || !pkg || rest.length) {
    throw new Error(`${name} is not a Packagist package, expected "vendor/name"`)
  }
  return { vendor, pkg }
}

/** The vendor listing is every package under the account's namespace, abandoned ones too. */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.packagist
  if (!account) return []
  const { data } = await getJson<{ packageNames: string[] }>(
    `${API}/packages/list.json?vendor=${encodeURIComponent(account)}`,
  )
  if (!data?.packageNames) throw new Error('Packagist answered no package list')
  return data.packageNames.map((name) => ({ name: name.toLowerCase(), discovered: 'auto' }))
}

/** "1.2.0.0-beta1" as numbers plus a prerelease part, which a release outranks. */
function compareNormalized(a: string, b: string): number {
  const [aNum = '', aPre] = a.split('-', 2)
  const [bNum = '', bPre] = b.split('-', 2)
  const an = aNum.split('.').map(Number)
  const bn = bNum.split('.').map(Number)
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0)
    if (d) return d
  }
  if (!aPre || !bPre) return aPre ? -1 : bPre ? 1 : 0
  return aPre.localeCompare(bPre, 'en', { numeric: true })
}

/**
 * Branches publish as `dev-…` or `….x-dev` and are not releases. The newest stable tag is
 * the version, a prerelease only when nothing else shipped, and the last release is the
 * newest tag of any kind.
 */
function releases(versions: Record<string, Version>): {
  version: string | null
  lastPublish: string | null
} {
  const tags = Object.values(versions).filter(
    (v) => !v.version_normalized.startsWith('dev-') && !v.version_normalized.endsWith('-dev'),
  )
  const stable = tags.filter((v) => !v.version_normalized.includes('-'))
  const best = (stable.length ? stable : tags)
    .toSorted((a, b) => compareNormalized(a.version_normalized, b.version_normalized))
    .at(-1)
  const times = tags.map((v) => v.time).filter((t): t is string => Boolean(t))
  return {
    version: best ? best.version.replace(/^v/i, '') : null,
    lastPublish: times.toSorted().at(-1) ?? null,
  }
}

/**
 * The package document carries the lifetime total and the stats endpoint a year of
 * per-day downloads. Packagist also mirrors the repo's GitHub stars, forks and issues,
 * which the `gh:` target already measures first hand, so they are left out.
 */
async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const name = descriptor.name.toLowerCase()
  const { vendor, pkg } = split(name)
  const path = `${API}/packages/${encodeURIComponent(vendor)}/${encodeURIComponent(pkg)}`
  const from = new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10)
  const pending = getJson<Stats>(`${path}/stats/all.json?average=daily&from=${from}`)
  // The stats endpoint answers 404 for a deleted package too, and only the package's own
  // document may say it is gone, so that one is read first.
  pending.catch(() => {})
  const meta = await orGone(getJson<Package>(`${path}.json`))
  const stats = await pending
  const info = meta.data?.package
  if (!info) throw new Error(`no package data for ${name}`)

  const counts = Object.values(stats.data?.values ?? {})[0] ?? []
  const series: SeriesPoint[] = (stats.data?.labels ?? []).map((date, i) => ({
    date,
    downloads: counts[i] ?? 0,
  }))
  const repo = githubRepoFromUrl(info.repository)

  const snapshot: Snapshot = {
    id: targetId('packagist', name),
    ecosystem: 'packagist',
    name,
    url: `${API}/packages/${vendor}/${pkg}`,
    discovered: descriptor.discovered,
    metrics: {
      downloadsDay: series.at(-1)?.downloads ?? null,
      downloadsWeek: series.length ? sumLast(series, 7) : null,
      downloadsMonth: series.length ? sumLast(series, 30) : null,
      downloadsTotal: info.downloads?.total ?? null,
      favers: info.favers ?? null,
      dependents: info.dependents ?? null,
      ...releases(info.versions ?? {}),
      deprecated: info.abandoned ? 'yes' : 'no',
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }
  const fetched: Fetched = { snapshot, series }
  if (info.description) fetched.detail = { description: info.description }
  return fetched
}

export const packagistSource: Source = {
  ecosystem: 'packagist',
  roster: true,
  discover,
  fetch: fetchOne,
}
