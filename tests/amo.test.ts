import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { amoSource } from '../src/sources/amo.ts'

let dir: string
let requested: string[]
let pages: unknown[]
const realFetch = globalThis.fetch

function addon(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'rebobinate',
    guid: 'rebobinate@shbernal.github.io',
    url: 'https://addons.mozilla.org/en-US/firefox/addon/rebobinate/',
    name: { 'en-US': 'Rebobinate' },
    summary: { 'en-US': 'Control playback speed.' },
    average_daily_users: 41,
    weekly_downloads: 7,
    ratings: { average: 4.5, count: 2 },
    current_version: { version: '0.1.1' },
    last_updated: '2026-08-07T09:45:32Z',
    homepage: { url: { 'en-US': 'https://github.com/shbernal/rebobinate' } },
    support_url: { url: { 'en-US': 'https://github.com/shbernal/rebobinate/issues' } },
    ...overrides,
  }
}

function config(overrides: Partial<Config> = {}): Config {
  return { ...structuredClone(DEFAULT_CONFIG), accounts: { amo: '20068285' }, ...overrides }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  pages = [{ count: 1, next: null, results: [addon()] }]
  globalThis.fetch = (async (url: URL | string) => {
    requested.push(url.toString())
    const body = pages.length > 1 ? pages.shift() : pages[0]
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  globalThis.fetch = realFetch
})

test('discovery keys on the numeric author id and pages until next is empty', async () => {
  pages = [
    { count: 2, next: 'page-2', results: [addon()] },
    { count: 2, next: null, results: [addon({ slug: 'tiktok-feed-blocker' })] },
  ]
  const found = await amoSource.discover(config({ accounts: { amo: '20068285' } }))
  expect(found.map((d) => d.name)).toEqual(['rebobinate', 'tiktok-feed-blocker'])
  expect(requested[0]).toContain('author=20068285')
  expect(requested).toHaveLength(2)
})

test('no configured author means nothing is discovered and nothing is requested', async () => {
  expect(await amoSource.discover(config({ accounts: {} }))).toEqual([])
  expect(requested).toEqual([])
})

test('search already carries every metric, so a discovered add-on costs no second request', async () => {
  const [descriptor] = await amoSource.discover(config())
  requested = []
  const { snapshot, series } = await amoSource.fetch(descriptor!, config())

  expect(requested).toEqual([])
  expect(snapshot.id).toBe('amo:rebobinate')
  expect(snapshot.metrics.users).toBe(41)
  expect(snapshot.metrics.downloadsWeek).toBe(7)
  expect(snapshot.metrics.version).toBe('0.1.1')
  // AMO serves per-day history only to the owner, so a level is all there is.
  expect(series).toBeUndefined()
})

test('an unrated add-on reports no rating rather than a score of zero', async () => {
  const rated = await amoSource.fetch(
    { name: 'rebobinate', discovered: 'auto', hint: addon() },
    config(),
  )
  expect(rated.snapshot.metrics.rating).toBe(4.5)
  expect(rated.snapshot.metrics.ratings).toBe(2)

  const fresh = await amoSource.fetch(
    { name: 'rebobinate', discovered: 'auto', hint: addon({ ratings: { average: 0, count: 0 } }) },
    config(),
  )
  expect(fresh.snapshot.metrics.rating).toBeNull()
  // Nobody has rated it is a known fact. What the score would be is not.
  expect(fresh.snapshot.metrics.ratings).toBe(0)
})

test('the homepage is what links an add-on to the repo it is built from', async () => {
  const linked = await amoSource.fetch(
    { name: 'rebobinate', discovered: 'auto', hint: addon() },
    config(),
  )
  expect(linked.snapshot.links).toEqual(['gh:shbernal/rebobinate'])

  // Support URLs point at the issue tracker, and the repo is still what that names.
  const fallback = await amoSource.fetch(
    { name: 'rebobinate', discovered: 'auto', hint: addon({ homepage: null }) },
    config(),
  )
  expect(fallback.snapshot.links).toEqual(['gh:shbernal/rebobinate'])

  const orphan = await amoSource.fetch(
    { name: 'rebobinate', discovered: 'auto', hint: addon({ homepage: null, support_url: null }) },
    config(),
  )
  expect(orphan.snapshot.links).toEqual([])
})

test('a 304 on a targeted refetch keeps the stored values and only moves fetchedAt', async () => {
  const previous = (
    await amoSource.fetch({ name: 'rebobinate', discovered: 'config', hint: addon() }, config())
  ).snapshot
  globalThis.fetch = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch

  const again = await amoSource.fetch(
    { name: 'rebobinate', discovered: 'config' },
    config(),
    previous,
  )
  expect(again.snapshot.metrics).toEqual(previous.metrics)
  expect(again.snapshot.fetchedAt >= previous.fetchedAt).toBe(true)
})
