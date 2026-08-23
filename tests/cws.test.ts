import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { cwsSource } from '../src/sources/cws.ts'

const ID = 'hjagmapcdgdffjbbedipfoocmkmhbjeh'
const LISTING = readFileSync(new URL('./fixtures/cws-listing.html', import.meta.url), 'utf8')

let dir: string
let requested: string[]
let page: string
const realFetch = globalThis.fetch

function config(overrides: Partial<Config> = {}): Config {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides }
}

function fetchOne(name = ID) {
  return cwsSource.fetch({ name, discovered: 'config' }, config())
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_DATA_DIR = dir
  resetHttpCache()
  requested = []
  page = LISTING
  globalThis.fetch = (async (url: URL | string) => {
    requested.push(url.toString())
    return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_DATA_DIR
  globalThis.fetch = realFetch
})

test('the listing page yields the metrics the store publishes', async () => {
  const { snapshot, detail } = await fetchOne()
  expect(requested).toEqual([`https://chromewebstore.google.com/detail/${ID}?hl=en`])
  expect(snapshot.id).toBe(`cws:${ID}`)
  expect(snapshot.metrics.title).toBe('TikTok Feed Blocker')
  expect(snapshot.metrics.version).toBe('1.4.0')
  expect(snapshot.metrics.lastPublish).toBe('2026-08-05')
  expect(snapshot.metrics.offeredBy).toBe('shbernal')
  expect(detail).toEqual({ description: "Block TikTok's most distracting features." })
  // The canonical slug comes off the page, so the stored URL is the one a human opens.
  expect(snapshot.url).toBe(`https://chromewebstore.google.com/detail/tiktok-feed-blocker/${ID}`)
})

test('the user count stays the text Google published, because it is a bucket', async () => {
  const { snapshot } = await fetchOne()
  expect(snapshot.metrics.users).toBe('1,000')
})

test('the rating belongs to this listing and not to the extensions it advertises', async () => {
  const { snapshot } = await fetchOne()
  expect(snapshot.metrics.rating).toBe(4.8)
  expect(snapshot.metrics.ratings).toBe(12)
})

test('a missing field costs that metric and never the target', async () => {
  page = LISTING.replace('<div class="QDHp8e">Version</div><div>1.4.0</div>', '')
    .replace('1,000 users', '')
    .replace('August 5, 2026', 'not a date')
  const { snapshot } = await fetchOne()
  expect(snapshot.metrics.version).toBeNull()
  expect(snapshot.metrics.users).toBeNull()
  expect(snapshot.metrics.lastPublish).toBeNull()
  expect(snapshot.metrics.title).toBe('TikTok Feed Blocker')
})

test('a page that is not a listing is an error rather than an empty snapshot', async () => {
  page = '<html><body>Not found</body></html>'
  expect(fetchOne()).rejects.toThrow(/no store listing/)
})

test('an id that is not a store id is refused before a request is spent', async () => {
  expect(fetchOne('tiktok-feed-blocker')).rejects.toThrow(/32 letters/)
  expect(requested).toEqual([])
})

test('extensions are named in config, because the store lists none by developer', async () => {
  expect(await cwsSource.discover(config())).toEqual([])
  const named = await cwsSource.discover(config({ include: [`cws:${ID}`, 'pypi:thing'] }))
  expect(named).toEqual([{ name: ID, discovered: 'config' }])
})
