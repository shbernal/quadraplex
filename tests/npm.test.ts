import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { npmSource } from '../src/sources/npm.ts'
import { PartialDiscovery } from '../src/sources/types.ts'

let dir: string
let requested: string[]
const realFetch = globalThis.fetch

/** Search hits, the roster and packuments, keyed by the shape of the URL that asks. */
type Registry = {
  search: string[]
  owned: string[] | null
  packuments: Record<string, unknown>
  bulkDown?: boolean
  versionsDown?: boolean
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
  return { ...structuredClone(DEFAULT_CONFIG), accounts: { npm: 'shbernal' }, ...overrides }
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
  if (url.startsWith('https://api.npmjs.org/versions')) {
    if (registry.versionsDown) return new Response('busy', { status: 503 })
    return json({ downloads: { '1.0.0': 5, '1.1.0-next.1': 2, '0.9.0': 0 } })
  }
  if (url.startsWith('https://api.npmjs.org/downloads')) {
    const range = { downloads: [{ day: '2026-08-30', downloads: 7 }] }
    const names = decodeURIComponent(url.split('/last-year/')[1]!).split(',')
    if (names.length > 1) {
      if (registry.bulkDown) return new Response('busy', { status: 400 })
      return json(Object.fromEntries(names.map((n) => [n, n === 'fresh' ? null : range])))
    }
    if (names[0] === 'fresh') return new Response('not found', { status: 404 })
    return json(range)
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
  process.env.QUADRAPLEX_HOME = dir
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
  delete process.env.QUADRAPLEX_HOME
  globalThis.fetch = realFetch
})

test('discovery is the ownership roster, not the search index that omits deprecated packages', async () => {
  const found = await npmSource.discover(config())
  expect(found.map((d) => d.name).toSorted()).toEqual(['live', 'retired'])
  // The search hit still spares the package its packument request.
  expect(found.find((d) => d.name === 'live')?.hint).toHaveProperty('search')
  expect(found.find((d) => d.name === 'retired')?.hint).not.toHaveProperty('search')
})

test('a roster that cannot be read hands over what search found, flagged partial', async () => {
  registry.owned = null
  const failure = await npmSource.discover(config()).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(PartialDiscovery)
  expect((failure as PartialDiscovery).found.map((d) => d.name)).toEqual(['live'])
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

test('a package search and bulk downloads already answered costs only its version split', async () => {
  const found = await npmSource.discover(config())
  requested = []
  const fetched = await npmSource.fetch(
    found.find((d) => d.name === 'live')!,
    config(),
  )
  expect(requested).toEqual(['https://api.npmjs.org/versions/live/last-week'])
  expect(fetched.snapshot.metrics.downloadsWeek).toBe(7)
  expect(fetched.snapshot.versions).toEqual({ '1.0.0': 5, '1.1.0-next.1': 2 })
})

test('a version split that cannot be read costs the split, not the target', async () => {
  registry.versionsDown = true
  const fetched = await npmSource.fetch(
    { name: 'live', discovered: 'auto', hint: { search: hit('live') } },
    config(),
  )
  expect(fetched.snapshot.metrics.downloadsWeek).toBe(7)
  expect(fetched.snapshot).not.toHaveProperty('versions')
})

test('unscoped downloads come in one bulk request, scoped ones each in their own', async () => {
  registry.search = ['a', 'b', '@shbernal/c']
  registry.owned = registry.search
  const found = await npmSource.discover(config())
  const downloads = requested.filter((url) => url.includes('api.npmjs.org/downloads'))
  expect(downloads).toEqual(['https://api.npmjs.org/downloads/range/last-year/a,b'])

  requested = []
  await npmSource.fetch(
    found.find((d) => d.name === '@shbernal/c')!,
    config(),
  )
  expect(requested).toEqual([
    'https://api.npmjs.org/downloads/range/last-year/%40shbernal%2Fc',
    'https://api.npmjs.org/versions/%40shbernal%2Fc/last-week',
  ])
})

test('a failed bulk request leaves each package to fetch its own downloads', async () => {
  registry.bulkDown = true
  const found = await npmSource.discover(config())
  requested = []
  const fetched = await npmSource.fetch(
    found.find((d) => d.name === 'live')!,
    config(),
  )
  expect(requested[0]).toBe('https://api.npmjs.org/downloads/range/last-year/live')
  expect(fetched.snapshot.metrics.downloadsWeek).toBe(7)
})

test('a package the stats service has not caught up with has unknown downloads, not a failure', async () => {
  const alone = await npmSource.fetch(
    { name: 'fresh', discovered: 'auto', hint: { search: hit('fresh') } },
    config(),
  )
  expect(alone.snapshot.metrics.downloadsWeek).toBeNull()
  expect(alone.snapshot.metrics.version).toBe('1.0.0')
  expect(alone.series).toBeUndefined()

  // Bulk answers null for it, which is the same answer.
  registry.search = ['live', 'fresh']
  const found = await npmSource.discover(config())
  requested = []
  const fetched = await npmSource.fetch(
    found.find((d) => d.name === 'fresh')!,
    config(),
  )
  expect(requested).toEqual([])
  expect(fetched.snapshot.metrics.downloadsWeek).toBeNull()
})
