import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { jsrSource } from '../src/sources/jsr.ts'
import { Gone } from '../src/sources/types.ts'

const API = 'https://api.jsr.io/scopes/me/packages'
const DAY_MS = 24 * 60 * 60 * 1000
const day = (back: number) => new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10)

let dir: string
let requested: string[]
let routes: Record<string, () => Response>
const realFetch = globalThis.fetch

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const pkg = (name: string, extra: Record<string, unknown> = {}) => ({
  scope: 'me',
  name,
  description: 'A slug maker',
  githubRepository: { id: 1, owner: 'me', name: 'slug' },
  runtimeCompat: { node: true, deno: true, browser: false },
  updatedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  versionCount: 3,
  dependencyCount: 0,
  dependentCount: 4,
  score: 94,
  latestVersion: '0.3.0',
  whenFeatured: null,
  isArchived: false,
  readmeSource: 'readme',
  symbolCount: null,
  ...extra,
})

const config = () => ({ ...structuredClone(DEFAULT_CONFIG), accounts: { jsr: 'me' } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  routes = {
    [`${API}?limit=100&page=1`]: () =>
      json({
        items: [pkg('slug'), pkg('old', { isArchived: true, latestVersion: null })],
        total: 2,
      }),
    [`${API}/slug`]: () => json(pkg('slug')),
    [`${API}/slug/versions/0.3.0`]: () =>
      json({ version: '0.3.0', yanked: false, createdAt: '2026-10-20T09:00:00Z' }),
    [`${API}/slug/downloads`]: () =>
      json({
        total: [
          { timeBucket: `${day(40)}T00:00:00Z`, kind: 'npm_tarball', count: 100 },
          { timeBucket: `${day(3)}T00:00:00Z`, kind: 'jsr_meta', count: 2 },
          { timeBucket: `${day(3)}T00:00:00Z`, kind: 'npm_tarball', count: 5 },
          { timeBucket: `${day(1)}T00:00:00Z`, kind: 'jsr_meta', count: 1 },
          { timeBucket: `${day(0)}T00:00:00Z`, kind: 'jsr_meta', count: 50 },
        ],
        recentVersions: [],
      }),
    [`${API}/old/downloads`]: () => json({ total: [], recentVersions: [] }),
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

test('discovery reads the scope listing and keeps each package as a hint', async () => {
  const found = await jsrSource.discover(config())
  expect(found.map((d) => d.name)).toEqual(['@me/slug', '@me/old'])
  expect(found[0]!.hint).toEqual(pkg('slug'))
})

test('a discovered package costs its downloads and its latest version', async () => {
  const [hinted] = await jsrSource.discover(config())
  requested = []
  const { snapshot, series, detail } = await jsrSource.fetch(hinted!, config())
  expect(requested.toSorted()).toEqual([`${API}/slug/downloads`, `${API}/slug/versions/0.3.0`])
  expect(snapshot.id).toBe('jsr:@me/slug')
  expect(snapshot.url).toBe('https://jsr.io/@me/slug')
  expect(snapshot.links).toEqual(['gh:me/slug'])
  expect(detail).toEqual({ description: 'A slug maker' })
  // Kinds are summed, missing days are zeros, and today's unfinished bucket is left out.
  expect(series).toHaveLength(89)
  expect(series!.at(-1)).toEqual({ date: day(1), downloads: 1 })
  expect(snapshot.metrics).toEqual({
    downloadsDay: 1,
    downloadsWeek: 8,
    downloadsMonth: 8,
    version: '0.3.0',
    lastPublish: '2026-10-20T09:00:00Z',
    score: 94,
    runtimes: 'deno,node',
    dependents: 4,
    archived: 'no',
  })
})

test('a package with no version and no downloads reads as zeros, not unknown', async () => {
  const [, old] = await jsrSource.discover(config())
  const { snapshot } = await jsrSource.fetch(old!, config())
  expect(snapshot.metrics).toMatchObject({
    downloadsWeek: 0,
    version: null,
    lastPublish: null,
    archived: 'yes',
  })
})

test('a named package without a hint reads its metadata, and a missing one is gone', async () => {
  const { snapshot } = await jsrSource.fetch({ name: '@me/slug', discovered: 'config' }, config())
  expect(requested[0]).toBe(`${API}/slug`)
  expect(snapshot.metrics.score).toBe(94)
  expect(
    jsrSource.fetch({ name: '@me/deleted', discovered: 'config' }, config()),
  ).rejects.toBeInstanceOf(Gone)
})

test('a name without a scope is refused', () => {
  expect(jsrSource.fetch({ name: 'slug', discovered: 'config' }, config())).rejects.toThrow(
    'expected "@scope/name"',
  )
})
