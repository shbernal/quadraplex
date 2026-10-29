import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { cratesSource, daily, pacing } from '../src/sources/crates.ts'
import { Gone } from '../src/sources/types.ts'

const API = 'https://crates.io/api/v1'

let dir: string
let requested: string[]
let routes: Record<string, () => Response>
const realFetch = globalThis.fetch

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** Trimmed from a live `/api/v1/crates?user_id=` listing. */
const crate = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  name,
  created_at: '2019-01-13T01:41:33.503501Z',
  updated_at: '2026-09-08T01:07:03.441459Z',
  downloads: 1396493,
  recent_downloads: 228377,
  default_version: '0.1.14',
  num_versions: 16,
  yanked: false,
  max_version: '0.1.14',
  newest_version: '0.1.14',
  description: 'Command line arguments by reference',
  homepage: null,
  documentation: 'https://docs.rs/argv',
  repository: 'https://github.com/me/argv',
  ...extra,
})

const today = new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) =>
  new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10)

const config = () => ({ ...structuredClone(DEFAULT_CONFIG), accounts: { crates: 'me' } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  pacing.intervalMs = 0
  resetHttpCache()
  requested = []
  routes = {
    [`${API}/users/me`]: () => json({ user: { id: 3618, login: 'me' } }),
    [`${API}/crates?user_id=3618&per_page=100`]: () =>
      json({
        crates: [crate('argv')],
        meta: { next_page: '?user_id=3618&per_page=100&seek=MTA4', prev_page: null },
      }),
    [`${API}/crates?user_id=3618&per_page=100&seek=MTA4`]: () =>
      json({
        crates: [crate('withdrawn', { yanked: true, repository: null })],
        meta: { next_page: null, prev_page: null },
      }),
    [`${API}/crates/argv`]: () => json({ crate: crate('argv'), versions: null }),
    [`${API}/crates/argv/downloads`]: () =>
      json({
        version_downloads: [
          { version: 1, downloads: 10, date: daysAgo(1) },
          { version: 2, downloads: 5, date: daysAgo(1) },
          { version: 1, downloads: 7, date: daysAgo(3) },
          { version: 1, downloads: 99, date: today },
        ],
        meta: { extra_downloads: [{ date: daysAgo(10), downloads: 4 }] },
      }),
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
  pacing.intervalMs = 1000
})

test('discovery resolves the login to its id and follows the seek cursor', async () => {
  const found = await cratesSource.discover(config())
  expect(found.map((d) => d.name)).toEqual(['argv', 'withdrawn'])
  expect(found[0]!.hint).toEqual(crate('argv'))
})

test('an unknown login answers 404, which init reads as nothing found', async () => {
  const error = await cratesSource
    .discover({ ...config(), accounts: { crates: 'nobody' } })
    .catch((caught: unknown) => caught)
  expect(error).toMatchObject({ status: 404 })
})

test('a discovered crate costs only its downloads table', async () => {
  const [hinted] = await cratesSource.discover(config())
  requested = []
  const { snapshot, series, detail } = await cratesSource.fetch(hinted!, config())
  expect(requested).toEqual([`${API}/crates/argv/downloads`])
  expect(snapshot.id).toBe('crates:argv')
  expect(snapshot.url).toBe('https://crates.io/crates/argv')
  expect(snapshot.links).toEqual(['gh:me/argv'])
  expect(snapshot.metrics).toEqual({
    downloadsDay: 15,
    downloadsWeek: 22,
    downloadsMonth: 26,
    downloadsTotal: 1396493,
    version: '0.1.14',
    lastPublish: '2026-09-08T01:07:03.441459Z',
    deprecated: 'no',
  })
  expect(series!.at(-1)).toEqual({ date: daysAgo(1), downloads: 15 })
  expect(detail).toEqual({ description: 'Command line arguments by reference' })
})

test('the series fills gaps with zeros, starts no earlier than the crate, and drops today', () => {
  const series = daily(
    { version_downloads: [{ date: daysAgo(1), downloads: 3 }], meta: {} },
    `${daysAgo(3)}T12:00:00Z`,
  )
  expect(series).toEqual([
    { date: daysAgo(3), downloads: 0 },
    { date: daysAgo(2), downloads: 0 },
    { date: daysAgo(1), downloads: 3 },
  ])
  expect(daily(null, '2015-01-01T00:00:00Z')).toHaveLength(89)
})

test('a fully yanked crate reads as deprecated', async () => {
  const [, yanked] = await cratesSource.discover(config())
  routes[`${API}/crates/withdrawn/downloads`] = () =>
    json({ version_downloads: [], meta: { extra_downloads: [] } })
  const { snapshot } = await cratesSource.fetch(yanked!, config())
  expect(snapshot.metrics.deprecated).toBe('yes')
  expect(snapshot.metrics.downloadsWeek).toBe(0)
  expect(snapshot.links).toEqual([])
})

test('a named crate reads itself first, and a missing one is gone', async () => {
  const { snapshot } = await cratesSource.fetch({ name: 'argv', discovered: 'config' }, config())
  expect(requested).toEqual([`${API}/crates/argv`, `${API}/crates/argv/downloads`])
  expect(snapshot.metrics.downloadsTotal).toBe(1396493)
  const error = await cratesSource
    .fetch({ name: 'deleted', discovered: 'config' }, config())
    .catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(Gone)
})

test('requests keep the crawler interval apart, even from concurrent fetches', async () => {
  pacing.intervalMs = 40
  const started = Date.now()
  await Promise.all([
    cratesSource.fetch({ name: 'argv', discovered: 'config' }, config()),
    cratesSource.fetch({ name: 'argv', discovered: 'config' }, config()),
  ])
  expect(Date.now() - started).toBeGreaterThanOrEqual(3 * 40 - 5)
})
