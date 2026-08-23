import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { ghcrSource, newestVersion, parse } from '../src/sources/ghcr.ts'
import { Gone } from '../src/sources/types.ts'

const PACKAGE = readFileSync(new URL('./fixtures/ghcr-package.html', import.meta.url), 'utf8')
const PAGE = 'https://github.com/users/shbernal/packages/container/package/alcatraz'

let dir: string
let requested: string[]
let routes: Record<string, () => Response>
const realFetch = globalThis.fetch

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } })
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const tab = (page: number) => `https://github.com/shbernal?tab=packages&page=${page}`
const link = (name: string) =>
  `<a href="/users/shbernal/packages/container/package/${name}">${name}</a>`

const config = () => ({ ...structuredClone(DEFAULT_CONFIG), accounts: { ghcr: 'shbernal' } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  routes = {
    [PAGE]: () => html(PACKAGE),
    'https://ghcr.io/token?scope=repository%3Ashbernal%2Falcatraz%3Apull': () =>
      json({ token: 'anonymous' }),
    'https://ghcr.io/v2/shbernal/alcatraz/tags/list?n=1000': () =>
      json({ tags: ['latest', 'sha-1a2b3c', '0.2.0', '0.10.0', '1.0.0-rc.1'] }),
  }
  globalThis.fetch = (async (url: URL | string) => {
    requested.push(url.toString())
    return routes[url.toString()]?.() ?? new Response('not found', { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  globalThis.fetch = realFetch
})

test('the package page yields the exact total, the publish time and the linked repo', () => {
  const page = parse(PACKAGE, '2026-10-02')
  expect(page.downloadsTotal).toBe(10)
  expect(page.lastPublish).toBe('2026-10-01T15:49:22.000Z')
  expect(page.repo).toBe('shbernal/alcatraz')
  // Today is still counting, so the series stops at yesterday.
  expect(page.series).toHaveLength(29)
  expect(page.series.at(-1)!.date).toBe('2026-10-01')
  expect(page.series.reduce((sum, point) => sum + point.downloads, 0)).toBe(10)
})

test('a page that stops matching costs the metric, not the target', () => {
  const page = parse('<html></html>', '2026-10-02')
  expect(page).toEqual({ downloadsTotal: null, lastPublish: null, series: [], repo: null })
})

test('the version is the highest release tag, prereleases only when nothing else shipped', () => {
  expect(newestVersion(['latest', 'sha-abc', '0.2.0', 'v0.10.0', '1.0.0-rc.1'])).toBe('0.10.0')
  expect(newestVersion(['1.0.0-rc.2', '1.0.0-rc.10', 'main'])).toBe('1.0.0-rc.10')
  expect(newestVersion(['latest'])).toBeNull()
})

test('an image snapshot reads the page and the registry tags, and links its repo', async () => {
  const { snapshot, series } = await ghcrSource.fetch(
    { name: 'shbernal/alcatraz', discovered: 'auto' },
    config(),
  )
  expect(snapshot.id).toBe('ghcr:shbernal/alcatraz')
  expect(snapshot.url).toBe(PAGE)
  expect(snapshot.metrics.downloadsTotal).toBe(10)
  expect(snapshot.metrics.version).toBe('0.10.0')
  expect(snapshot.links).toEqual(['gh:shbernal/alcatraz'])
  expect(series!.length).toBeGreaterThan(0)
})

test('a package whose page is gone retires instead of failing the refresh', async () => {
  routes = {}
  const error = await ghcrSource
    .fetch({ name: 'shbernal/alcatraz', discovered: 'auto' }, config())
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(Gone)
})

test('discovery walks the packages tab until a page adds nothing new', async () => {
  routes = {
    [tab(1)]: () => html(link('alcatraz') + link('Other')),
    [tab(2)]: () => html(link('nested%2Fimage')),
    [tab(3)]: () => html(link('alcatraz')),
  }
  const found = await ghcrSource.discover(config())
  expect(found.map((d) => d.name)).toEqual([
    'shbernal/alcatraz',
    'shbernal/other',
    'shbernal/nested/image',
  ])
  expect(requested).toEqual([tab(1), tab(2), tab(3)])
})
