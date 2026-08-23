import { getJson } from '../core/http.ts'
import { parseTargetId, targetId, type SeriesPoint, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { githubRepoFromUrl, sumLast, type Descriptor, type Fetched, type Source } from './types.ts'

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

/**
 * Warehouse exposes no endpoint for packages by user, so unlike npm there is nothing to
 * discover. The list comes from config, and status says so out loud, because an empty
 * section is otherwise indistinguishable from having no PyPI packages at all.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  return config.include
    .map(parseTargetId)
    .filter((parsed) => parsed?.ecosystem === 'pypi')
    .map((parsed) => ({ name: parsed!.name, discovered: 'config' as const }))
}

async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const name = descriptor.name
  const [meta, stats] = await Promise.all([
    getJson<Warehouse>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`),
    getJson<Overall>(`https://pypistats.org/api/packages/${encodeURIComponent(name)}/overall`),
  ])

  // The two series arrive interleaved in one array. with_mirrors inflates the number and
  // summing both double counts, so only without_mirrors is ever shown.
  const series: SeriesPoint[] = (stats.data?.data ?? [])
    .filter((point) => point.category === 'without_mirrors')
    .map((point) => ({ date: point.date, downloads: point.downloads }))
    .toSorted((a, b) => a.date.localeCompare(b.date))

  const info = meta.data?.info
  const projectUrls = Object.values(info?.project_urls ?? {})
  const repo = [...projectUrls, info?.home_page ?? '']
    .map(githubRepoFromUrl)
    .find((value): value is string => Boolean(value))

  const snapshot: Snapshot = {
    id: targetId('pypi', name),
    ecosystem: 'pypi',
    name,
    url: `https://pypi.org/project/${name}/`,
    discovered: descriptor.discovered,
    metrics: {
      downloadsDay: series.at(-1)?.downloads ?? 0,
      downloadsWeek: sumLast(series, 7),
      downloadsMonth: sumLast(series, 30),
      version: info?.version ?? null,
      lastPublish: meta.data?.urls?.[0]?.upload_time_iso_8601 ?? null,
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
  discover,
  fetch: fetchOne,
}
