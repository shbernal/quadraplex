import { postText } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { Gone, githubRepoFromUrl, type Descriptor, type Fetched, type Source } from './types.ts'

const GALLERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'
const ACCEPT = 'application/json;api-version=7.2-preview.1'
const PAGE = 100
/** Discovery stops here even if the count keeps promising more, so it cannot loop. */
const MAX_PAGES = 20

/** The gallery's filter and flag numbers, as VS Code itself sends them. */
const BY_NAME = 7
const FOR_VSCODE = 8
const BY_PUBLISHER = 18
const VERSION_PROPERTIES = 0x10
const STATISTICS = 0x100
const LATEST_ONLY = 0x200

type Extension = {
  publisher: { publisherName: string }
  extensionName: string
  displayName?: string
  flags: string
  lastUpdated: string
  /** One entry per target platform, each at its own latest version. */
  versions: {
    version: string
    lastUpdated: string
    properties?: { key: string; value: string }[]
  }[]
  statistics?: { statisticName: string; value: number }[]
}

type Answer = { results: { extensions: Extension[] }[] }

async function query(criteria: { filterType: number; value: string }[], page: number) {
  const body = JSON.stringify({
    filters: [{ criteria, pageNumber: page, pageSize: PAGE }],
    flags: VERSION_PROPERTIES | STATISTICS | LATEST_ONLY,
  })
  const { data } = await postText(GALLERY, body, 'application/json', { accept: ACCEPT })
  const answer = JSON.parse(data ?? '{}') as Answer
  return answer.results?.[0]?.extensions ?? []
}

const fullName = (e: Extension) => `${e.publisher.publisherName}.${e.extensionName}`.toLowerCase()
const unpublished = (e: Extension) => e.flags.split(/,\s*/).includes('unpublished')

/** The publisher filter is the roster: every public extension the publisher has listed. */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.vscode
  if (!account) return []
  const criteria = [
    { filterType: BY_PUBLISHER, value: account },
    { filterType: FOR_VSCODE, value: 'Microsoft.VisualStudio.Code' },
  ]
  const out: Descriptor[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const found = await query(criteria, page)
    for (const extension of found) {
      if (!unpublished(extension))
        out.push({ name: fullName(extension), discovered: 'auto', hint: extension })
    }
    if (found.length < PAGE) break
  }
  return out
}

/** The platform build published last carries the version a user is offered. */
function latest(extension: Extension) {
  return extension.versions.toSorted((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))[0]
}

/**
 * Installs is the Marketplace's lifetime count, with no per-day history, so the rate is
 * the delta between snapshots. A gallery query answers an unknown or unpublished name
 * with an empty list rather than a 404, so that is what retires it.
 */
async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  let extension = descriptor.fresh ? undefined : (descriptor.hint as Extension | undefined)
  if (!extension) {
    if (!/^[^.]+\.[^.]/.test(descriptor.name)) {
      throw new Error(
        `${descriptor.name} is not a Marketplace extension, expected "publisher.name"`,
      )
    }
    ;[extension] = await query([{ filterType: BY_NAME, value: descriptor.name }], 1)
    if (!extension || unpublished(extension)) {
      throw new Gone(`${descriptor.name} is not listed on the Marketplace`)
    }
  }
  const stats = new Map(extension.statistics?.map((s) => [s.statisticName, s.value]))
  const ratings = stats.get('ratingcount') ?? 0
  const average = stats.get('averagerating')
  const build = latest(extension)
  const property = (key: string) =>
    build?.properties?.find((p) => p.key === `Microsoft.VisualStudio.Services.Links.${key}`)?.value
  const repo = githubRepoFromUrl(property('Source') ?? property('GitHub') ?? property('Getstarted'))
  const name = fullName(extension)
  const snapshot: Snapshot = {
    id: targetId('vscode', name),
    ecosystem: 'vscode',
    name,
    url: `https://marketplace.visualstudio.com/items?itemName=${name}`,
    discovered: descriptor.discovered,
    metrics: {
      installs: stats.get('install') ?? null,
      // An unrated extension has no average at all, which is not a score of zero.
      rating: ratings && average !== undefined ? Math.round(average * 100) / 100 : null,
      ratings,
      version: build?.version ?? null,
      lastPublish: extension.lastUpdated,
      title: extension.displayName || null,
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }
  return { snapshot }
}

export const vscodeSource: Source = {
  ecosystem: 'vscode',
  roster: true,
  discover,
  fetch: fetchOne,
}
