import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { vscodeSource } from '../src/sources/vscode.ts'
import { Gone } from '../src/sources/types.ts'

let dir: string
let bodies: { filters: { criteria: { filterType: number; value: string }[] }[]; flags: number }[]
let answer: (criteria: { filterType: number; value: string }[]) => unknown[]
const realFetch = globalThis.fetch

/** Trimmed from a live gallery answer for one extension, flags 0x310. */
const extension = (name: string, extra: Record<string, unknown> = {}) => ({
  publisher: { publisherName: 'esbenp', displayName: 'Prettier', flags: 'verified' },
  extensionId: '96fa4707-6983-4489-b7c5-d5ffdfdcce90',
  extensionName: name,
  displayName: 'Prettier - Code formatter',
  flags: 'validated, public',
  lastUpdated: '2026-03-16T19:18:07.213Z',
  publishedDate: '2017-01-10T19:52:02.703Z',
  shortDescription: 'Code formatter using prettier',
  versions: [
    {
      version: '1.14.0',
      targetPlatform: 'linux-armhf',
      flags: 'validated',
      lastUpdated: '2023-01-16T08:41:36.82Z',
      properties: [],
    },
    {
      version: '12.4.0',
      flags: 'validated',
      lastUpdated: '2026-03-16T19:18:07.213Z',
      properties: [
        {
          key: 'Microsoft.VisualStudio.Services.Links.Support',
          value: 'https://github.com/prettier/prettier-vscode/issues',
        },
        {
          key: 'Microsoft.VisualStudio.Services.Links.Source',
          value: 'https://github.com/prettier/prettier-vscode.git',
        },
      ],
    },
  ],
  statistics: [
    { statisticName: 'install', value: 69_000_000 },
    { statisticName: 'averagerating', value: 3.8724489212036133 },
    { statisticName: 'ratingcount', value: 392 },
    { statisticName: 'downloadCount', value: 1_200_000 },
  ],
  deploymentType: 0,
  ...extra,
})

const page = (extensions: unknown[]) => ({
  results: [
    {
      extensions,
      pagingToken: null,
      resultMetadata: [
        { metadataType: 'ResultCount', metadataItems: [{ name: 'TotalCount', count: 2 }] },
      ],
    },
  ],
})

const config = () => ({ ...structuredClone(DEFAULT_CONFIG), accounts: { vscode: 'esbenp' } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  bodies = []
  answer = () => []
  globalThis.fetch = (async (_url: URL | string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string)
    bodies.push(body)
    return new Response(JSON.stringify(page(answer(body.filters[0].criteria))), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  globalThis.fetch = realFetch
})

test('discovery filters by publisher, skips unpublished extensions and pays for each fetch', async () => {
  answer = () => [
    extension('prettier-vscode'),
    extension('old-thing', { flags: 'validated, public, unpublished' }),
  ]
  const found = await vscodeSource.discover(config())
  expect(bodies[0]!.filters[0]!.criteria).toEqual([
    { filterType: 18, value: 'esbenp' },
    { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
  ])
  expect(bodies[0]!.flags).toBe(0x310)
  expect(found.map((d) => d.name)).toEqual(['esbenp.prettier-vscode'])

  const { snapshot } = await vscodeSource.fetch(found[0]!, config())
  expect(bodies).toHaveLength(1)
  expect(snapshot.id).toBe('vscode:esbenp.prettier-vscode')
  expect(snapshot.url).toBe(
    'https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode',
  )
  expect(snapshot.metrics).toEqual({
    installs: 69_000_000,
    rating: 3.87,
    ratings: 392,
    version: '12.4.0',
    lastPublish: '2026-03-16T19:18:07.213Z',
    title: 'Prettier - Code formatter',
  })
  expect(snapshot.links).toEqual(['gh:prettier/prettier-vscode'])
})

test('no account skips discovery without a request', async () => {
  expect(await vscodeSource.discover({ ...config(), accounts: {} })).toEqual([])
  expect(bodies).toEqual([])
})

test('an unrated extension has no score, and a named one is read by its full name', async () => {
  answer = () => [extension('quiet', { statistics: [{ statisticName: 'install', value: 3 }] })]
  const { snapshot } = await vscodeSource.fetch(
    { name: 'esbenp.quiet', discovered: 'config' },
    config(),
  )
  expect(bodies[0]!.filters[0]!.criteria).toEqual([{ filterType: 7, value: 'esbenp.quiet' }])
  expect(snapshot.metrics).toMatchObject({ installs: 3, rating: null, ratings: 0 })
})

test('a name the gallery no longer lists is gone, and a name without a publisher is refused', () => {
  expect(
    vscodeSource.fetch({ name: 'esbenp.deleted', discovered: 'config' }, config()),
  ).rejects.toBeInstanceOf(Gone)
  expect(vscodeSource.fetch({ name: 'prettier', discovered: 'config' }, config())).rejects.toThrow(
    'expected "publisher.name"',
  )
})
