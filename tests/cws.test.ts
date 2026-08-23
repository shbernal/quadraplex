import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { cwsSource } from '../src/sources/cws.ts'
import { Gone } from '../src/sources/types.ts'

const ID = 'hjagmapcdgdffjbbedipfoocmkmhbjeh'
const LISTING = readFileSync(new URL('./fixtures/cws-listing.html', import.meta.url), 'utf8')

let dir: string
let requested: string[]
let page: string
let pages: Record<string, string>
const realFetch = globalThis.fetch

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    accounts: { github: 'shbernal', cws: 'shbernal' },
    ...overrides,
  }
}

function fetchOne(name = ID) {
  return cwsSource.fetch({ name, discovered: 'config' }, config())
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  page = LISTING
  pages = {}
  globalThis.fetch = (async (url: URL | string) => {
    requested.push(url.toString())
    return new Response(pages[url.toString()] ?? page, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
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

test('an own listing links to the account repo named like its slug', async () => {
  expect((await fetchOne()).snapshot.links).toEqual(['gh:shbernal/tiktok-feed-blocker'])
  page = LISTING.replace('Offered by</div><div>shbernal', 'Offered by</div><div>someone')
  expect((await fetchOne()).snapshot.links).toEqual([])
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

const OTHER = 'abcdefghijklmnopabcdefghijklmnop'
const STRAY = 'ponmlkjihgfedcbaponmlkjihgfedcba'

test('discovery keeps the search hits whose listing is offered by the account', async () => {
  const search = 'https://chromewebstore.google.com/search/shbernal?hl=en'
  pages[search] =
    `<div data-item-id="${ID}"><a href="./detail/tiktok-feed-blocker/${ID}"></a></div>` +
    `<div data-item-id="${OTHER}"></div><script>["${STRAY}","${ID}"]</script>`
  pages[`https://chromewebstore.google.com/detail/${OTHER}?hl=en`] = LISTING.replace(
    'Offered by</div><div>shbernal',
    'Offered by</div><div>someone else',
  )
  pages[`https://chromewebstore.google.com/detail/${STRAY}?hl=en`] = '<html>Chrome Web Store</html>'

  const found = await cwsSource.discover(config())
  expect(found).toEqual([{ name: ID, discovered: 'auto', hint: LISTING }])
  expect(requested).toHaveLength(4)

  // The listing discovery read is the one the fetch parses.
  requested = []
  expect((await cwsSource.fetch(found[0]!, config())).snapshot.metrics.title).toBe(
    'TikTok Feed Blocker',
  )
  expect(requested).toEqual([])
})

test('no cws account skips discovery without a request', async () => {
  expect(await cwsSource.discover(config({ accounts: { npm: 'you' } }))).toEqual([])
  expect(requested).toEqual([])
})

test('a taken down listing, or a discovered one now offered by someone else, is gone', async () => {
  page = '<html><head><meta property="og:title" content="Chrome Web Store"></head></html>'
  expect(fetchOne()).rejects.toBeInstanceOf(Gone)

  page = LISTING.replace('Offered by</div><div>shbernal', 'Offered by</div><div>buyer')
  const auto = cwsSource.fetch({ name: ID, discovered: 'auto' }, config())
  expect(auto).rejects.toThrow(/now offered by buyer/)
  // Named in include on purpose, so whoever offers it, it is tracked.
  expect((await fetchOne()).snapshot.metrics.offeredBy).toBe('buyer')
})
