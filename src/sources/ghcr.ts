import { getJson, getText } from '../core/http.ts'
import { targetId, type SeriesPoint, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { orGone, sumLast, type Descriptor, type Fetched, type Source } from './types.ts'

const GITHUB = 'https://github.com'
const REGISTRY = 'https://ghcr.io'
/** Discovery stops here even if the tab keeps answering, so a layout change cannot loop. */
const MAX_PAGES = 20

const packageUrl = (owner: string, name: string) =>
  `${GITHUB}/users/${owner}/packages/container/package/${encodeURIComponent(name)}`

/** "owner/name", where the name may itself hold slashes, as images nested under a repo do. */
function split(name: string): { owner: string; image: string } {
  const at = name.indexOf('/')
  if (at < 1 || at === name.length - 1) {
    throw new Error(`${name} is not a container image, expected "owner/name"`)
  }
  return { owner: name.slice(0, at), image: name.slice(at + 1) }
}

/**
 * The profile's packages tab is the only anonymous listing. The REST packages API wants a
 * token with `read:packages`, which neither the default `gh` login nor a plain token has.
 * Container links only: npm and Maven packages hosted on GitHub are not images.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.ghcr
  if (!account) return []
  const link = new RegExp(`/users/${account}/packages/container/package/([^"?#&]+)`, 'gi')
  const names = new Set<string>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await getText(
      `${GITHUB}/${encodeURIComponent(account)}?tab=packages&page=${page}`,
    )
    const before = names.size
    for (const match of (data ?? '').matchAll(link)) {
      names.add(decodeURIComponent(match[1]!).toLowerCase())
    }
    if (names.size === before) break
  }
  return [...names].map((image) => ({
    name: `${account.toLowerCase()}/${image}`,
    discovered: 'auto',
  }))
}

/** The page shows a rounded figure and keeps the exact one in the heading's title. */
function titled(html: string, label: string): string | null {
  return new RegExp(`>\\s*${label}\\s*</span>\\s*<h3 title="([^"]+)"`).exec(html)?.[1] ?? null
}

/**
 * The 30 day bar chart beside the total carries each day's count as data attributes. The
 * day still in progress is dropped so a week means seven whole days, as on npm.
 */
function daily(html: string, today: string): SeriesPoint[] {
  const start = html.indexOf('aria-label="Downloads for the last 30 days"')
  if (start < 0) return []
  const chart = html.slice(start, html.indexOf('</svg>', start))
  return [...chart.matchAll(/data-merge-count="(\d+)"\s+data-date="(\d{4}-\d{2}-\d{2})"/g)]
    .map((match) => ({ date: match[2]!, downloads: Number(match[1]) }))
    .filter((point) => point.date < today)
    .toSorted((a, b) => a.date.localeCompare(b.date))
}

/**
 * The GitHub page is the only public reading of downloads: no API serves them, with a
 * token or without. Every field is parsed on its own and may come back null, so a layout
 * change costs a metric and keeps the target, as on the Chrome Web Store.
 */
export function parse(html: string, today = new Date().toISOString().slice(0, 10)) {
  const total = titled(html, 'Total downloads')
  const published = titled(html, 'Last published')
  const at = published ? Date.parse(published) : Number.NaN
  // A package connected to a repository names it in the sidebar, behind the repo octicon.
  const repo =
    /<a href="https:\/\/github\.com\/([^/"]+\/[^/"]+)"[^>]*><svg[^>]*octicon-repo\b/.exec(
      html,
    )?.[1] ?? null
  return {
    downloadsTotal: total !== null && /^\d+$/.test(total) ? Number(total) : null,
    lastPublish: Number.isNaN(at) ? null : new Date(at).toISOString(),
    series: daily(html, today),
    repo,
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i

function compare(a: RegExpExecArray, b: RegExpExecArray): number {
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i])
    if (d) return d
  }
  // A release outranks its own prereleases.
  if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : 0
  return a[4].localeCompare(b[4], 'en', { numeric: true })
}

/**
 * The highest version among the tags, `latest` and `sha-…` aside. A prerelease counts only
 * when the image has never shipped anything else.
 */
export function newestVersion(tags: string[]): string | null {
  const parsed = tags.map((tag) => SEMVER.exec(tag)).filter((m): m is RegExpExecArray => !!m)
  const stable = parsed.filter((m) => !m[4])
  const best = (stable.length ? stable : parsed).toSorted(compare).at(-1)
  return best ? best[0].replace(/^v/i, '') : null
}

/**
 * The registry hands out an anonymous pull token for any public image, so tags come from
 * the documented distribution API rather than the page, which only lists recent ones.
 */
async function registryTags(owner: string, image: string): Promise<string[]> {
  const scope = `repository:${owner}/${image}:pull`
  const { data: grant } = await getJson<{ token: string }>(
    `${REGISTRY}/token?scope=${encodeURIComponent(scope)}`,
  )
  if (!grant?.token) return []
  const { data } = await getJson<{ tags: string[] | null }>(
    `${REGISTRY}/v2/${owner}/${image}/tags/list?n=1000`,
    { token: grant.token },
  )
  return data?.tags ?? []
}

async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const { owner, image } = split(descriptor.name)
  const url = packageUrl(owner, image)
  // A private or deleted package answers 404 on its page, which is the one that may retire it.
  const { data } = await orGone(getText(url))
  const page = parse(data ?? '')
  if (page.downloadsTotal === null && page.lastPublish === null) {
    throw new Error(`${url} did not read as a container package page`)
  }
  const series = page.series
  const known = series.length > 0
  const snapshot: Snapshot = {
    id: targetId('ghcr', descriptor.name),
    ecosystem: 'ghcr',
    name: descriptor.name,
    url,
    discovered: descriptor.discovered,
    metrics: {
      downloadsDay: known ? series.at(-1)!.downloads : null,
      downloadsWeek: known ? sumLast(series, 7) : null,
      downloadsMonth: known ? sumLast(series, 30) : null,
      downloadsTotal: page.downloadsTotal,
      version: newestVersion(await registryTags(owner, image)),
      lastPublish: page.lastPublish,
    },
    links: page.repo ? [targetId('github', page.repo)] : [],
    fetchedAt: new Date().toISOString(),
  }
  return { snapshot, series }
}

export const ghcrSource: Source = {
  ecosystem: 'ghcr',
  // The tab is read as HTML, so a page that stops matching would look like an empty
  // portfolio. A package leaves only when its own page answers 404.
  roster: false,
  discover,
  fetch: fetchOne,
}
