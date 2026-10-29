import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { rubygemsSource } from '../src/sources/rubygems.ts'
import { Gone } from '../src/sources/types.ts'

const API = 'https://rubygems.org/api/v1'

let dir: string
let requested: string[]
let routes: Record<string, () => Response>
const realFetch = globalThis.fetch

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })

// Trimmed from a live answer: the owner listing and a single gem share this shape.
const gem = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  downloads: 14559,
  version: '1.0.2',
  version_created_at: '2026-07-25T17:46:24.000Z',
  version_downloads: 6138,
  platform: 'ruby',
  info: 'A parser.\n',
  yanked: false,
  homepage_uri: 'https://example.org',
  source_code_uri: 'https://github.com/me/zomg',
  ...extra,
})

const config = () => ({
  ...structuredClone(DEFAULT_CONFIG),
  accounts: { rubygems: 'me' },
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  routes = {
    [`${API}/owners/me/gems.json`]: () =>
      json([gem('zomg'), gem('carat', { yanked: true }), gem('yoda', { source_code_uri: null })]),
    [`${API}/gems/zomg.json`]: () => json(gem('zomg')),
    [`${API}/gems/carat.json`]: () => json(gem('carat', { yanked: true })),
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

test('discovery reads the owner listing in one request and skips yanked gems', async () => {
  const found = await rubygemsSource.discover(config())
  expect(found.map((d) => d.name)).toEqual(['zomg', 'yoda'])
  expect(requested).toEqual([`${API}/owners/me/gems.json`])
})

test('a discovered gem costs no request and keeps both lifetime counts', async () => {
  const [hinted] = await rubygemsSource.discover(config())
  requested = []
  const { snapshot, detail } = await rubygemsSource.fetch(hinted!, config())
  expect(requested).toEqual([])
  expect(snapshot.id).toBe('rubygems:zomg')
  expect(snapshot.url).toBe('https://rubygems.org/gems/zomg')
  expect(snapshot.links).toEqual(['gh:me/zomg'])
  expect(snapshot.metrics).toEqual({
    downloadsTotal: 14559,
    downloadsVersion: 6138,
    version: '1.0.2',
    lastPublish: '2026-07-25T17:46:24.000Z',
  })
  expect(detail).toEqual({ description: 'A parser.' })
})

test('a named gem reads its own resource, and a yanked or missing one is gone', async () => {
  const { snapshot } = await rubygemsSource.fetch({ name: 'zomg', discovered: 'config' }, config())
  expect(requested).toEqual([`${API}/gems/zomg.json`])
  expect(snapshot.metrics.downloadsTotal).toBe(14559)
  expect(
    rubygemsSource.fetch({ name: 'carat', discovered: 'config' }, config()),
  ).rejects.toBeInstanceOf(Gone)
  expect(
    rubygemsSource.fetch({ name: 'deleted', discovered: 'config' }, config()),
  ).rejects.toBeInstanceOf(Gone)
})
