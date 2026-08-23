import { getText, mapLimit } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { Gone, type Descriptor, type Fetched, type Source } from './types.ts'

const STORE = 'https://chromewebstore.google.com/detail'
const SEARCH = 'https://chromewebstore.google.com/search'
const ID = /^[a-p]{32}$/
const IDS = /\b[a-p]{32}\b/g

const ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

/** Store text arrives escaped, and an apostrophe in a title is common enough to matter. */
function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ref: string) => {
    if (!ref.startsWith('#')) return ENTITIES[ref.toLowerCase()] ?? whole
    const code = Number(ref[1]?.toLowerCase() === 'x' ? `0${ref.slice(1)}` : ref.slice(1))
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole
  })
}

function first(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html)?.[1]?.trim()
  return match ? decode(match) : null
}

/** The listing's own facts sit in a label and value list, keyed by the English label. */
function field(html: string, label: string): string | null {
  return first(html, new RegExp(`>${label}</div><div[^>]*>([^<]{1,60})</div>`))
}

function count(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

/** "August 5, 2026" is all the store publishes, and UTC keeps it from sliding a day. */
function isoDate(value: string | null): string | null {
  if (!value) return null
  const at = Date.parse(`${value} UTC`)
  return Number.isNaN(at) ? null : new Date(at).toISOString().slice(0, 10)
}

/**
 * The star average is the number the star glyph follows, and the page repeats that shape
 * for every related extension it advertises. The listing's own reviews link carries its
 * id, so the last match before that link is the only one that belongs to this item.
 */
function score(html: string, id: string): { rating: number | null; ratings: number | null } {
  const at = html.indexOf(`${id}/reviews`)
  if (at < 0) return { rating: null, ratings: null }
  const stars = [...html.slice(Math.max(0, at - 800), at).matchAll(/>(\d+(?:\.\d+)?)<\/span><svg/g)]
  return {
    rating: count(stars.at(-1)?.[1] ?? null),
    ratings: count(first(html.slice(at, at + 400), /([\d,]+) ratings/)),
  }
}

/**
 * The Chrome Web Store has no read API. Its publish API manages items and exposes no
 * metrics at all, and the dashboard's numbers never leave the browser, so the listing
 * page is the only public source. Every field is optional on purpose: a layout change
 * costs a metric and reports the rest, rather than dropping the target.
 */
function parse(html: string, id: string): Record<string, string | number | null> {
  const title = first(html, /<meta property="og:title" content="([^"]*) - Chrome Web Store"/)
  if (!title) throw new Gone(`no store listing for ${id}`)
  return {
    title,
    // Google publishes a bucket, not a count. "1,000 users" is a rounded label and the
    // badge is absent below a threshold, so this stays a string: a number here would
    // invite a delta, and a delta across buckets measures the boundary, not the users.
    users: first(html, />([\d,]+) users</),
    ...score(html, id),
    version: field(html, 'Version'),
    lastPublish: isoDate(field(html, 'Updated')),
    offeredBy: field(html, 'Offered by'),
  }
}

const listingUrl = (id: string) => `${STORE}/${id}?hl=en`

/**
 * The store has no developer page, but its search matches the developer name, and every
 * result's id is on the page, in its card and again in the embedded data. Any id there is
 * a candidate, kept only when its listing says it is offered by the account, so an
 * unrelated hit costs one page and a kept one hands that page to its fetch. Search
 * ranking is not a roster and an unlisted extension never shows, which `include` covers.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.cws
  if (!account) return []
  const { data } = await getText(`${SEARCH}/${encodeURIComponent(account)}?hl=en`)
  const candidates = [...new Set(data?.match(IDS) ?? [])]
  const listings = await mapLimit(candidates, 3, async (id) => ({
    id,
    html: (await getText(listingUrl(id))).data ?? '',
  }))
  return listings
    .filter(({ html }) => field(html, 'Offered by') === account)
    .map(({ id, html }) => ({ name: id, discovered: 'auto' as const, hint: html }))
}

async function fetchOne(descriptor: Descriptor, config: Config): Promise<Fetched> {
  const id = descriptor.name
  if (!ID.test(id)) {
    throw new Error(`${id} is not a Chrome Web Store id, which is 32 letters from a to p`)
  }

  // The store answers with no validator and no-store, so there is nothing to condition
  // on and every refresh pays for the page in full, unless discovery already did.
  const html =
    typeof descriptor.hint === 'string'
      ? descriptor.hint
      : ((await getText(listingUrl(id))).data ?? '')
  const metrics = parse(html, id)
  // A discovered extension that changed hands is no longer the account's. One named in
  // `include` was named on purpose, and an unreadable field proves nothing.
  const account = config.accounts.cws
  const offeredBy = metrics.offeredBy
  if (descriptor.discovered === 'auto' && account && offeredBy && offeredBy !== account) {
    throw new Gone(`now offered by ${offeredBy}`)
  }
  const slug = first(html, new RegExp(`/detail/([a-z0-9-]+)/${id}`))
  // A listing names no repository. The slug is the title lowercased and hyphenated, and on
  // the account's own listing the account's repo of that name is taken as its source.
  const owner = config.accounts.github
  const repo = slug && owner && account && offeredBy === account ? `${owner}/${slug}` : null

  const snapshot: Snapshot = {
    id: targetId('cws', id),
    ecosystem: 'cws',
    name: id,
    url: `${STORE}/${slug ?? id}/${id}`,
    discovered: descriptor.discovered,
    metrics,
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }

  const fetched: Fetched = { snapshot }
  const description = first(html, /<meta name="description" content="([^"]*)"/)
  if (description) fetched.detail = { description }
  return fetched
}

export const cwsSource: Source = {
  ecosystem: 'cws',
  roster: false,
  discover,
  fetch: fetchOne,
}
