import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { nugetSource } from '../src/sources/nuget.ts'
import { Gone } from '../src/sources/types.ts'

const INDEX = 'https://api.nuget.org/v3/index.json'
const SEARCH = 'https://azuresearch-usnc.nuget.org/query'
const REG = 'https://api.nuget.org/v3/registration5-gz-semver2/acme.widgets'
const query = (q: string) =>
  `${SEARCH}?q=${encodeURIComponent(q)}&prerelease=true&semVerLevel=2.0.0&take=1000&skip=0`

let dir: string
let requested: string[]
let routes: Record<string, () => Response>
const realFetch = globalThis.fetch

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })

const hit = (extra: Record<string, unknown> = {}) => ({
  '@id': `${REG}/index.json`,
  '@type': 'Package',
  id: 'Acme.Widgets',
  version: '3.0.0-beta1',
  description: 'Widgets for .NET',
  projectUrl: 'https://github.com/acme/widgets',
  owners: ['acme', 'acme-bot'],
  totalDownloads: 52_340,
  verified: true,
  versions: ['2.9.0', '2.10.0', '3.0.0-beta1'].map((version) => ({
    version,
    downloads: 10,
    '@id': `${REG}/${version}.json`,
  })),
  ...extra,
})

const config = () => ({
  ...structuredClone(DEFAULT_CONFIG),
  accounts: { nuget: 'acme' },
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  routes = {
    [INDEX]: () =>
      json({
        version: '3.0.0',
        resources: [
          { '@id': 'https://api.nuget.org/v3-flatcontainer/', '@type': 'PackageBaseAddress/3.0.0' },
          { '@id': SEARCH, '@type': 'SearchQueryService' },
        ],
      }),
    [query('owner:acme')]: () => json({ totalHits: 1, data: [hit()] }),
    [query('packageid:acme.widgets')]: () => json({ totalHits: 1, data: [hit()] }),
    [query('packageid:acme.gone')]: () => json({ totalHits: 0, data: [] }),
    [`${REG}/3.0.0-beta1.json`]: () => json({ published: '2026-10-19T16:31:21.31+00:00' }),
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

test('discovery finds the search service in the index and keeps each hit as a hint', async () => {
  const found = await nugetSource.discover(config())
  expect(requested).toEqual([INDEX, query('owner:acme')])
  expect(found.map((d) => d.name)).toEqual(['acme.widgets'])
  expect(found[0]!.hint).toEqual(hit())
})

test('a discovered package costs only its newest registration leaf', async () => {
  const [hinted] = await nugetSource.discover(config())
  requested = []
  const { snapshot, detail } = await nugetSource.fetch(hinted!, config())
  expect(requested).toEqual([`${REG}/3.0.0-beta1.json`])
  expect(snapshot.id).toBe('nuget:acme.widgets')
  expect(snapshot.url).toBe('https://www.nuget.org/packages/Acme.Widgets')
  expect(snapshot.links).toEqual(['gh:acme/widgets'])
  expect(snapshot.metrics).toEqual({
    downloadsTotal: 52_340,
    version: '2.10.0',
    lastPublish: '2026-10-19T16:31:21.31+00:00',
    verified: 'yes',
  })
  expect(detail).toEqual({ description: 'Widgets for .NET' })
})

test('a named package is looked up by id in any case, and an unlisted one is gone', async () => {
  const { snapshot } = await nugetSource.fetch(
    { name: 'Acme.Widgets', discovered: 'config' },
    config(),
  )
  expect(snapshot.id).toBe('nuget:acme.widgets')
  expect(snapshot.metrics.downloadsTotal).toBe(52_340)
  expect(
    nugetSource.fetch({ name: 'acme.gone', discovered: 'config' }, config()),
  ).rejects.toBeInstanceOf(Gone)
})

test('a discovered package now owned by someone else is gone, an included one is kept', async () => {
  routes[query('packageid:acme.widgets')] = () =>
    json({ totalHits: 1, data: [hit({ owners: ['someone'] })] })
  expect(nugetSource.fetch({ name: 'acme.widgets', discovered: 'auto' }, config())).rejects.toThrow(
    'now owned by someone',
  )
  const { snapshot } = await nugetSource.fetch(
    { name: 'acme.widgets', discovered: 'config' },
    config(),
  )
  expect(snapshot.metrics.verified).toBe('yes')
})
