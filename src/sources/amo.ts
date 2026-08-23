import { getJson } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { githubRepoFromUrl, type Descriptor, type Fetched, type Source } from './types.ts'

const API = 'https://addons.mozilla.org/api/v5/addons'
const PAGE = 50

/** Localised strings arrive as a map of locale to text, or as a bare string. */
type Localised = string | Record<string, string> | null

type Addon = {
  slug: string
  guid: string
  url: string
  name: Localised
  summary?: Localised
  average_daily_users: number
  weekly_downloads?: number
  ratings?: { average: number; count: number }
  current_version?: { version?: string }
  last_updated: string | null
  homepage?: { url?: Record<string, string> } | null
  support_url?: { url?: Record<string, string> } | null
}

type Search = { count: number; next: string | null; results: Addon[] }

function text(value: Localised): string | null {
  if (typeof value === 'string') return value || null
  if (!value) return null
  return value['en-US'] ?? Object.values(value)[0] ?? null
}

function link(field: Addon['homepage']): string | null {
  return field?.url ? (text(field.url) ?? null) : null
}

/**
 * The author filter takes the numeric user id, which is the only stable handle when an
 * account has no public username. Search returns the full add-on serialiser, so one
 * request discovers the portfolio and pays for every fetch in it.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.amo
  if (!account) return []
  const out: Descriptor[] = []
  for (let page = 1; ; page++) {
    const url = `${API}/search/?author=${encodeURIComponent(account)}&page_size=${PAGE}&page=${page}`
    const { data } = await getJson<Search>(url)
    for (const addon of data?.results ?? []) {
      out.push({ name: addon.slug, discovered: 'auto', hint: addon })
    }
    if (!data?.next) break
  }
  return out
}

async function fetchOne(
  descriptor: Descriptor,
  _config: Config,
  previous?: Snapshot,
): Promise<Fetched> {
  let addon = descriptor.hint as Addon | undefined

  if (!addon) {
    const url = `${API}/addon/${encodeURIComponent(descriptor.name)}/`
    const response = await getJson<Addon>(url, { conditional: true })
    if (response.notModified && previous) {
      return { snapshot: { ...previous, fetchedAt: new Date().toISOString() } }
    }
    if (!response.data) throw new Error(`no add-on data for ${descriptor.name}`)
    addon = response.data
  }

  const ratings = addon.ratings
  const repo = githubRepoFromUrl(link(addon.homepage) ?? link(addon.support_url))
  const snapshot: Snapshot = {
    id: targetId('amo', addon.slug),
    ecosystem: 'amo',
    name: addon.slug,
    url: addon.url,
    discovered: descriptor.discovered,
    metrics: {
      users: addon.average_daily_users,
      // Same unit as the registries, so a project's weekly downloads can include Firefox.
      downloadsWeek: addon.weekly_downloads ?? null,
      // An unrated add-on reports an average of 0, which is not a score. Say unknown.
      rating: ratings?.count ? Math.round(ratings.average * 100) / 100 : null,
      ratings: ratings?.count ?? null,
      version: addon.current_version?.version ?? null,
      lastPublish: addon.last_updated,
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }

  const detail: Record<string, unknown> = { guid: addon.guid }
  const title = text(addon.name)
  const summary = text(addon.summary ?? null)
  if (title) detail.title = title
  if (summary) detail.summary = summary
  return { snapshot, detail }
}

/**
 * AMO serves no per-day history to anyone but the add-on's owner, so there is no series
 * to fetch. Daily users behaves like a star count: it is a level, and its history is the
 * one this tool accumulates in snapshots.jsonl from the day it starts looking.
 */
export const amoSource: Source = {
  ecosystem: 'amo',
  discover,
  fetch: fetchOne,
}
