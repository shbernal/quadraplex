import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { npmSource } from '../src/sources/npm.ts'

let dir: string
let requested: string[]
const realFetch = globalThis.fetch

/** Search hits, the roster and packuments, keyed by the shape of the URL that asks. */
type Registry = {
  search: string[]
  owned: string[] | null
  packuments: Record<string, unknown>
}

let registry: Registry

function hit(name: string) {
  return {
    package: {
      name,
      version: '1.0.0',
      date: '2026-08-01T00:00:00.000Z',
      links: { repository: `https://github.com/shbernal/${name}.git` },
    },
  }
}

function packument(name: string, deprecated?: string) {
  const version: Record<string, unknown> = {}
  if (deprecated) version.deprecated = deprecated
  return {
    'dist-tags': { latest: '2.0.0' },
    time: { '2.0.0': '2026-08-02T00:00:00.000Z' },
    repository: { url: `git+https://github.com/shbernal/${name}.git` },
    versions: { '2.0.0': version },
  }
}

function config(overrides: Partial<Config> = {}): Config {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides }
}

function respond(url: string): Response {
  if (url.includes('/-/v1/search')) {
    const objects = url.includes('from=0') ? registry.search.map(hit) : []
    return json({ total: registry.search.length, objects })
  }
  if (url.includes('/-/user/')) {
    if (registry.owned === null) return new Response('not found', { status: 404 })
    return json(Object.fromEntries(registry.owned.map((name) => [name, 'write'])))
  }
  if (url.startsWith('https://api.npmjs.org/downloads')) {
    return json({ downloads: [{ day: '2026-08-30', downloads: 7 }] })
  }
  const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''))
  const found = registry.packuments[name]
  if (!found) return new Response('not found', { status: 404 })
  return json(found)
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_DATA_DIR = dir
  resetHttpCache()
  requested = []
  registry = {
    search: ['live'],
    owned: ['live', 'retired'],
    packuments: { retired: packument('retired', 'use something else') },
  }
  globalThis.fetch = (async (url: URL | string) => {
    const text = url.toString()
    requested.push(text)
    return respond(text)
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_DATA_DIR
  globalThis.fetch = realFetch
})

test('discovery is the ownership roster, not the search index that omits deprecated packages', async () => {
  const found = await npmSource.discover(config())
  expect(found.map((d) => d.name).toSorted()).toEqual(['live', 'retired'])
  // The search hit still spares the package its packument request.
  expect(found.find((d) => d.name === 'live')?.hint).toBeDefined()
  expect(found.find((d) => d.name === 'retired')?.hint).toBeUndefined()
})

test('a roster that cannot be read degrades to search rather than emptying the portfolio', async () => {
  registry.owned = null
  const found = await npmSource.discover(config())
  expect(found.map((d) => d.name)).toEqual(['live'])
})

test('every package snapshot records whether its latest version is deprecated', async () => {
  const found = await npmSource.discover(config())
  const byName = new Map(found.map((d) => [d.name, d]))

  const live = await npmSource.fetch(byName.get('live')!, config())
  expect(live.snapshot.metrics.deprecated).toBe('no')

  const retired = await npmSource.fetch(byName.get('retired')!, config())
  expect(retired.snapshot.metrics.deprecated).toBe('yes')
  // Still measured, so an undeprecate is picked up rather than freezing the target.
  expect(retired.snapshot.metrics.downloadsWeek).toBe(7)
  expect(retired.snapshot.links).toEqual(['gh:shbernal/retired'])
})

test('a package still in the search index is answered without a packument request', async () => {
  const found = await npmSource.discover(config())
  requested = []
  await npmSource.fetch(
    found.find((d) => d.name === 'live')!,
    config(),
  )
  expect(requested).toHaveLength(1)
  expect(requested[0]).toContain('api.npmjs.org/downloads')
})
