import { getJson, HttpError } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import {
  githubRepoFromUrl,
  orGone,
  revalidated,
  type Descriptor,
  type Fetched,
  type Source,
} from './types.ts'

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
  authors?: { id: number; name: string }[]
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

type Account = { id: number; name: string; num_addons_listed: number }

/** An account found through an add-on's author list rather than by its own key. */
type FoundAccount = Account & { byDisplayName?: true }

async function lookup(key: string): Promise<Account | null> {
  const url = `https://addons.mozilla.org/api/v5/accounts/account/${encodeURIComponent(key)}/`
  return (await getJson<Account>(url)).data
}

/**
 * The accounts API takes a username or a numeric id. Its answer carries the id discovery
 * keys on and the display name a person recognises. AMO no longer lets anyone set a
 * username, so most accounts only answer to their id, and a handle that 404s is retried
 * as a display name through add-on search. Display names are not unique: only a single
 * matching author counts, and the result says it was matched that way.
 */
export async function findAccount(handle: string): Promise<FoundAccount | null> {
  try {
    return await lookup(handle)
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 404)) throw error
  }
  const url = `${API}/search/?q=${encodeURIComponent(handle)}&page_size=${PAGE}`
  const { data } = await getJson<Search>(url)
  const wanted = handle.toLowerCase()
  const ids = new Set(
    (data?.results ?? [])
      .flatMap((addon) => addon.authors ?? [])
      .filter((author) => author.name.toLowerCase() === wanted)
      .map((author) => author.id),
  )
  if (ids.size !== 1) return null
  const found = await lookup(String([...ids][0]))
  return found && { ...found, byDisplayName: true }
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
    let response = await orGone(getJson<Addon>(url, { conditional: true }))
    if (response.notModified && previous) {
      return { snapshot: revalidated(previous) }
    }
    // An ETag outliving the snapshot it vouched for is a cache miss, never an error.
    if (response.notModified) response = await getJson<Addon>(url)
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
  roster: true,
  discover,
  fetch: fetchOne,
}
