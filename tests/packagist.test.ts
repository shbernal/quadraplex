import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { packagistSource } from '../src/sources/packagist.ts'
import { Gone } from '../src/sources/types.ts'

const API = 'https://packagist.org/packages'

let dir: string
let requested: string[]
let routes: Record<string, () => Response>
const realFetch = globalThis.fetch

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })

const version = (name: string, normalized: string, time: string) => ({
  version: name,
  version_normalized: normalized,
  time,
})

const pkg = (extra: Record<string, unknown> = {}) => ({
  package: {
    name: 'acme/widget',
    description: 'Widgets for PHP',
    repository: 'https://github.com/acme/widget',
    github_stars: 120,
    github_forks: 7,
    github_open_issues: 3,
    dependents: 14,
    favers: 125,
    downloads: { total: 98_765, monthly: 3_100, daily: 101 },
    versions: {
      'dev-main': version('dev-main', 'dev-main', '2026-10-22T15:09:00+00:00'),
      'v2.x-dev': version('v2.x-dev', '2.9999999.9999999.9999999-dev', '2026-10-21T00:00:00+00:00'),
      'v3.0.0-beta1': version('v3.0.0-beta1', '3.0.0.0-beta1', '2026-10-19T16:31:21+00:00'),
      'v2.10.0': version('v2.10.0', '2.10.0.0', '2026-09-01T10:00:00+00:00'),
      'v2.9.1': version('v2.9.1', '2.9.1.0', '2026-08-01T10:00:00+00:00'),
    },
    ...extra,
  },
})

const config = () => ({
  ...structuredClone(DEFAULT_CONFIG),
  accounts: { packagist: 'acme' },
})

const days = Array.from({ length: 31 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  routes = {
    [`${API}/list.json?vendor=acme`]: () => json({ packageNames: ['acme/widget', 'acme/Gadget'] }),
    [`${API}/acme/widget.json`]: () => json(pkg()),
    [`${API}/acme/widget/stats/all.json`]: () =>
      json({
        labels: days,
        values: { 'acme/widget': days.map((_, i) => i + 1) },
        average: 'daily',
      }),
  }
  globalThis.fetch = (async (url: URL | string) => {
    requested.push(url.toString())
    // The stats window is dated from today, so it is matched without its query.
    const route = routes[url.toString()] ?? routes[url.toString().split('?')[0]!]
    return route?.() ?? new Response('not found', { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  globalThis.fetch = realFetch
})

test('discovery lists the vendor and lowercases every name', async () => {
  const found = await packagistSource.discover(config())
  expect(found.map((d) => d.name)).toEqual(['acme/widget', 'acme/gadget'])
})

test('a package reads its document and a year of daily downloads', async () => {
  const { snapshot, series, detail } = await packagistSource.fetch(
    { name: 'acme/widget', discovered: 'auto' },
    config(),
  )
  expect(requested[0]).toStartWith(`${API}/acme/widget/stats/all.json?average=daily&from=`)
  expect(snapshot.id).toBe('packagist:acme/widget')
  expect(snapshot.url).toBe('https://packagist.org/packages/acme/widget')
  expect(snapshot.links).toEqual(['gh:acme/widget'])
  expect(series).toHaveLength(31)
  expect(snapshot.metrics).toEqual({
    downloadsDay: 31,
    downloadsWeek: 25 + 26 + 27 + 28 + 29 + 30 + 31,
    downloadsMonth: (31 * 32) / 2 - 1,
    downloadsTotal: 98_765,
    favers: 125,
    dependents: 14,
    version: '2.10.0',
    lastPublish: '2026-10-19T16:31:21+00:00',
    deprecated: 'no',
  })
  expect(detail).toEqual({ description: 'Widgets for PHP' })
})

test('an abandoned package reads as deprecated, and one with only prereleases shows one', async () => {
  routes[`${API}/acme/widget.json`] = () =>
    json(
      pkg({
        abandoned: 'acme/gizmo',
        versions: {
          'v1.0.0-RC1': version('v1.0.0-RC1', '1.0.0.0-RC1', '2026-01-01T00:00:00+00:00'),
          'v1.0.0-beta2': version('v1.0.0-beta2', '1.0.0.0-beta2', '2025-12-01T00:00:00+00:00'),
        },
      }),
    )
  const { snapshot } = await packagistSource.fetch(
    { name: 'acme/widget', discovered: 'auto' },
    config(),
  )
  expect(snapshot.metrics.deprecated).toBe('yes')
  expect(snapshot.metrics.version).toBe('1.0.0-RC1')
})

test('a deleted package is gone, and a name without a vendor is refused', () => {
  expect(
    packagistSource.fetch({ name: 'acme/deleted', discovered: 'auto' }, config()),
  ).rejects.toBeInstanceOf(Gone)
  expect(packagistSource.fetch({ name: 'widget', discovered: 'config' }, config())).rejects.toThrow(
    'expected "vendor/name"',
  )
})
