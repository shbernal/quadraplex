import { getText } from '../core/http.ts'
import { parseTargetId, targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import type { Descriptor, Fetched, Source } from './types.ts'

const STORE = 'https://chromewebstore.google.com/detail'
const ID = /^[a-p]{32}$/

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
  if (!title) throw new Error(`no store listing for ${id}`)
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

/**
 * There is no listing of one developer's extensions to read, so the ids come from config
 * the way PyPI packages do. An id is the 32 letter string in the store URL.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  return config.include
    .map(parseTargetId)
    .filter((parsed) => parsed?.ecosystem === 'cws')
    .map((parsed) => ({ name: parsed!.name, discovered: 'config' as const }))
}

async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  const id = descriptor.name
  if (!ID.test(id)) {
    throw new Error(`${id} is not a Chrome Web Store id, which is 32 letters from a to p`)
  }

  // The store answers with no validator and no-store, so there is nothing to condition
  // on and every refresh pays for the page in full.
  const { data } = await getText(`${STORE}/${id}?hl=en`)
  const html = data ?? ''
  const metrics = parse(html, id)
  const slug = first(html, new RegExp(`/detail/([a-z0-9-]+)/${id}`))

  const snapshot: Snapshot = {
    id: targetId('cws', id),
    ecosystem: 'cws',
    name: id,
    url: `${STORE}/${slug ?? id}/${id}`,
    discovered: descriptor.discovered,
    metrics,
    links: [],
    fetchedAt: new Date().toISOString(),
  }

  const fetched: Fetched = { snapshot }
  const description = first(html, /<meta name="description" content="([^"]*)"/)
  if (description) fetched.detail = { description }
  return fetched
}

export const cwsSource: Source = {
  ecosystem: 'cws',
  discover,
  fetch: fetchOne,
}
