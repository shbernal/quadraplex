import { getJson, type Response } from '../core/http.ts'
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

const API = 'https://crates.io/api/v1'
const PAGE = 100
/** Discovery stops here even if `next_page` keeps answering, so a misbehaving cursor cannot loop. */
const MAX_PAGES = 20
/** crates.io's downloads table keeps 90 days, today included, so 89 whole ones. */
const WINDOW_DAYS = 89
const DAY_MS = 86_400_000

/**
 * crates.io asks crawlers for at most one request per second. Every request to it takes
 * the next free slot, whichever fetch it belongs to, so the cap holds under concurrency.
 */
export const pacing = { intervalMs: 1000 }
let nextSlot = 0

async function paced<T>(url: string): Promise<Response<T>> {
  const slot = Math.max(Date.now(), nextSlot)
  nextSlot = slot + pacing.intervalMs
  const wait = slot - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  return getJson<T>(url)
}

type Crate = {
  name: string
  created_at: string
  /** Moved by every publish, and only by one, so it is when the newest version went out. */
  updated_at: string
  downloads: number
  default_version: string | null
  /** Every version yanked, crates.io's way of withdrawing a crate. */
  yanked: boolean
  description: string | null
  repository: string | null
  homepage: string | null
}

type Listing = { crates: Crate[]; meta: { next_page: string | null } }

type Downloads = {
  version_downloads: { date: string; downloads: number }[]
  /** Versions past the five busiest, folded into one count per day. */
  meta: { extra_downloads?: { date: string; downloads: number }[] }
}

/** crates.io logins are GitHub logins, and the crate listing keys on the numeric user id. */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.crates
  if (!account) return []
  const { data: user } = await paced<{ user: { id: number } }>(
    `${API}/users/${encodeURIComponent(account)}`,
  )
  if (!user) throw new Error(`no crates.io user data for ${account}`)
  const out: Descriptor[] = []
  let url: string | null = `${API}/crates?user_id=${user.user.id}&per_page=${PAGE}`
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const listing: Response<Listing> = await paced<Listing>(url)
    for (const crate of listing.data?.crates ?? []) {
      out.push({ name: crate.name, discovered: 'auto', hint: crate })
    }
    const next: string | null | undefined = listing.data?.meta.next_page
    url = next ? `${API}/crates${next}` : null
  }
  return out
}

/**
 * The table only holds days with downloads, split by version, so the days are summed and
 * the gaps filled with zeros from the crate's first day in the window to yesterday. The day
 * in progress is dropped. crates.io is the counter itself, so a gap is a real zero.
 */
export function daily(
  body: Downloads | null,
  createdAt: string,
  today = new Date().toISOString().slice(0, 10),
): SeriesPoint[] {
  const totals = new Map<string, number>()
  for (const point of [...(body?.version_downloads ?? []), ...(body?.meta.extra_downloads ?? [])]) {
    totals.set(point.date, (totals.get(point.date) ?? 0) + point.downloads)
  }
  const end = Date.parse(today)
  const first = Math.max(end - WINDOW_DAYS * DAY_MS, Date.parse(createdAt.slice(0, 10)))
  const series: SeriesPoint[] = []
  for (let at = first; at < end; at += DAY_MS) {
    const date = new Date(at).toISOString().slice(0, 10)
    series.push({ date, downloads: totals.get(date) ?? 0 })
  }
  return series
}

/** A discovered crate pays for its downloads table only; a named one reads itself first. */
async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const path = `${API}/crates/${encodeURIComponent(descriptor.name)}`
  let crate = descriptor.fresh ? undefined : (descriptor.hint as Crate | undefined)
  if (!crate) {
    const { data } = await orGone(paced<{ crate: Crate }>(path))
    if (!data) throw new Error(`no crate data for ${descriptor.name}`)
    crate = data.crate
  }
  const { data: downloads } = await paced<Downloads>(`${path}/downloads`)
  const series = daily(downloads, crate.created_at)
  const repo = githubRepoFromUrl(crate.repository) ?? githubRepoFromUrl(crate.homepage)

  const snapshot: Snapshot = {
    id: targetId('crates', crate.name),
    ecosystem: 'crates',
    name: crate.name,
    url: `https://crates.io/crates/${encodeURIComponent(crate.name)}`,
    discovered: descriptor.discovered,
    metrics: {
      downloadsDay: series.at(-1)?.downloads ?? 0,
      downloadsWeek: sumLast(series, 7),
      downloadsMonth: sumLast(series, 30),
      downloadsTotal: crate.downloads,
      version: crate.default_version,
      lastPublish: crate.updated_at,
      deprecated: crate.yanked ? 'yes' : 'no',
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }
  const fetched: Fetched = { snapshot, series }
  if (crate.description) fetched.detail = { description: crate.description.trim() }
  return fetched
}

export const cratesSource: Source = {
  ecosystem: 'crates',
  roster: true,
  discover,
  fetch: fetchOne,
}
