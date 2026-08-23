import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { dockerhubSource } from '../src/sources/dockerhub.ts'
import { Gone } from '../src/sources/types.ts'

const API = 'https://hub.docker.com/v2/namespaces/shbernal/repositories'

let dir: string
let requested: string[]
let routes: Record<string, () => Response>
const realFetch = globalThis.fetch

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  namespace: 'shbernal',
  is_private: false,
  star_count: 2,
  pull_count: 153,
  last_updated: '2026-10-09T16:48:22.6588Z',
  ...extra,
})

const config = () => ({
  ...structuredClone(DEFAULT_CONFIG),
  accounts: { dockerhub: 'shbernal' },
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  routes = {
    [`${API}?page_size=100`]: () =>
      json({
        next: `${API}?page=2&page_size=100`,
        results: [repo('alcatraz')],
      }),
    [`${API}?page=2&page_size=100`]: () =>
      json({
        next: null,
        results: [repo('secret', { is_private: true }), repo('Sandbox')],
      }),
    [`${API}/alcatraz`]: () => json(repo('alcatraz')),
    [`${API}/alcatraz/tags?page_size=100`]: () =>
      json({
        results: ['latest', 'sha-1a2b3c', '0.2.0', '0.10.0'].map((name) => ({
          name,
        })),
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
})

test('discovery follows the listing, skips private images and keeps each as a hint', async () => {
  const found = await dockerhubSource.discover(config())
  expect(found.map((d) => d.name)).toEqual(['shbernal/alcatraz', 'shbernal/sandbox'])
  expect(found[0]!.hint).toEqual(repo('alcatraz'))
})

test('a discovered image costs only its tags, and keeps the lifetime pull count', async () => {
  const [hinted] = await dockerhubSource.discover(config())
  requested = []
  const { snapshot } = await dockerhubSource.fetch(hinted!, config())
  expect(requested).toEqual([`${API}/alcatraz/tags?page_size=100`])
  expect(snapshot.id).toBe('dockerhub:shbernal/alcatraz')
  expect(snapshot.url).toBe('https://hub.docker.com/r/shbernal/alcatraz')
  expect(snapshot.metrics).toEqual({
    downloadsTotal: 153,
    stars: 2,
    version: '0.10.0',
    lastPublish: '2026-10-09T16:48:22.6588Z',
  })
})

test('a named image without a hint reads its repository, and a missing one is gone', async () => {
  const { snapshot } = await dockerhubSource.fetch(
    { name: 'shbernal/alcatraz', discovered: 'config' },
    config(),
  )
  expect(requested[0]).toBe(`${API}/alcatraz`)
  expect(snapshot.metrics.downloadsTotal).toBe(153)
  expect(
    dockerhubSource.fetch({ name: 'shbernal/deleted', discovered: 'config' }, config()),
  ).rejects.toBeInstanceOf(Gone)
})

test('a name without a namespace is refused', () => {
  expect(
    dockerhubSource.fetch({ name: 'alcatraz', discovered: 'config' }, config()),
  ).rejects.toThrow('expected "namespace/name"')
})
