import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { openvsxSource } from '../src/sources/openvsx.ts'
import { Gone } from '../src/sources/types.ts'

const API = 'https://open-vsx.org/api'

let dir: string
let requested: string[]
let routes: Record<string, () => Response>
const realFetch = globalThis.fetch

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Trimmed from a live answer for one extension. */
const extension = (name: string, extra: Record<string, unknown> = {}) => ({
  namespace: 'redhat',
  name,
  displayName: 'Language Support for Java(TM) by Red Hat',
  version: '1.59.2026102908',
  timestamp: '2026-10-29T08:16:04.729474Z',
  downloadCount: 47_311_222,
  averageRating: 4.555555555555555,
  reviewCount: 16,
  deprecated: false,
  repository: 'https://github.com/redhat-developer/vscode-java.git',
  homepage: 'https://github.com/redhat-developer/vscode-java#readme',
  verified: true,
  ...extra,
})

const config = () => ({ ...structuredClone(DEFAULT_CONFIG), accounts: { openvsx: 'redhat' } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  routes = {
    [`${API}/redhat`]: () =>
      json({
        name: 'redhat',
        verified: true,
        extensions: {
          java: `${API}/redhat/java`,
          'mta-go': `${API}/redhat/mta-go`,
        },
      }),
    [`${API}/redhat/java`]: () => json(extension('java')),
    [`${API}/redhat/mta-go`]: () =>
      json(
        extension('mta-go', {
          displayName: '',
          averageRating: undefined,
          reviewCount: 0,
          deprecated: true,
          repository: undefined,
          homepage: 'https://developers.redhat.com/products/mta/overview',
        }),
      ),
  }
  globalThis.fetch = (async (url: URL | string) => {
    requested.push(url.toString())
    return routes[url.toString()]?.() ?? json({ error: 'Extension not found: redhat.nope' }, 404)
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  globalThis.fetch = realFetch
})

test('discovery reads the namespace roster, and each extension costs its own request', async () => {
  const found = await openvsxSource.discover(config())
  expect(found.map((d) => d.name)).toEqual(['redhat.java', 'redhat.mta-go'])
  requested = []
  const { snapshot } = await openvsxSource.fetch(found[0]!, config())
  expect(requested).toEqual([`${API}/redhat/java`])
  expect(snapshot.id).toBe('openvsx:redhat.java')
  expect(snapshot.url).toBe('https://open-vsx.org/extension/redhat/java')
  expect(snapshot.metrics).toEqual({
    downloadsTotal: 47_311_222,
    rating: 4.56,
    ratings: 16,
    version: '1.59.2026102908',
    lastPublish: '2026-10-29T08:16:04.729474Z',
    deprecated: 'no',
    title: 'Language Support for Java(TM) by Red Hat',
  })
  expect(snapshot.links).toEqual(['gh:redhat-developer/vscode-java'])
})

test('an unreviewed extension has no score, and a deprecated one says so', async () => {
  const { snapshot } = await openvsxSource.fetch(
    { name: 'redhat.mta-go', discovered: 'auto' },
    config(),
  )
  expect(snapshot.metrics).toMatchObject({
    rating: null,
    ratings: 0,
    deprecated: 'yes',
    title: null,
  })
  expect(snapshot.links).toEqual([])
})

test('no account skips discovery without a request', async () => {
  expect(await openvsxSource.discover({ ...config(), accounts: {} })).toEqual([])
  expect(requested).toEqual([])
})

test('a missing extension is gone, and a name without a namespace is refused', () => {
  expect(
    openvsxSource.fetch({ name: 'redhat.nope', discovered: 'config' }, config()),
  ).rejects.toBeInstanceOf(Gone)
  expect(openvsxSource.fetch({ name: 'java', discovered: 'config' }, config())).rejects.toThrow(
    'expected "namespace.name"',
  )
})
