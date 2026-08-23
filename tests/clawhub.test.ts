import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { clawhubSource } from '../src/sources/clawhub.ts'
import { Gone } from '../src/sources/types.ts'

let dir: string
let requests: { url: string; body: string | null }[]
let pages: unknown[]
let detail: { status: number; body: unknown }
const realFetch = globalThis.fetch

const json = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': status === 200 ? 'application/json' : 'text/plain' },
  })

function config(overrides: Partial<Config> = {}): Config {
  return { ...structuredClone(DEFAULT_CONFIG), accounts: { clawhub: 'me' }, ...overrides }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requests = []
  pages = []
  detail = {
    status: 200,
    body: {
      skill: {
        slug: 'rfc-lookup',
        displayName: 'RFC lookup',
        stats: { downloads: 824, installs: 1, stars: 0, versions: 9 },
      },
      latestVersion: { version: '0.5.1', createdAt: Date.parse('2026-10-05T07:23:09Z') },
      owner: { handle: 'me' },
    },
  }
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    requests.push({ url: url.toString(), body: (init?.body as string) ?? null })
    if (init?.method === 'POST') return json(pages.shift())
    return json(detail.body, detail.status)
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  globalThis.fetch = realFetch
})

const page = (slugs: string[], cursor: string) => ({
  status: 'success',
  value: {
    page: slugs.map((slug) => ({ slug, kind: 'skill' })),
    continueCursor: cursor,
    isDone: !cursor,
  },
})

test("discovery reads the publisher page's roster and follows its cursor", async () => {
  pages = [page(['rfc-lookup', 'email-compat'], '2'), page(['ooxml-lookup'], '')]
  const found = await clawhubSource.discover(config())
  expect(found.map((d) => d.name)).toEqual(['rfc-lookup', 'email-compat', 'ooxml-lookup'])
  const args = requests.map((r) => JSON.parse(r.body!).args)
  expect(args.map((a) => [a.handle, a.paginationOpts.cursor])).toEqual([
    ['me', null],
    ['me', '2'],
  ])
})

test('a query the deployment refuses fails discovery rather than emptying the roster', async () => {
  pages = [{ status: 'error', errorMessage: 'Could not find public function' }]
  expect(clawhubSource.discover(config())).rejects.toThrow('Could not find public function')
})

test('a fetch asks for the skill under the account and keeps all-time installs', async () => {
  const { snapshot } = await clawhubSource.fetch(
    { name: 'rfc-lookup', discovered: 'auto' },
    config(),
  )
  expect(requests[0]!.url).toBe('https://clawhub.ai/api/v1/skills/rfc-lookup?ownerHandle=me')
  expect(snapshot.id).toBe('clawhub:rfc-lookup')
  expect(snapshot.url).toBe('https://clawhub.ai/me/skills/rfc-lookup')
  expect(snapshot.metrics).toEqual({
    installs: 1,
    downloads: 824,
    stars: 0,
    version: '0.5.1',
    lastPublish: '2026-10-05T07:23:09.000Z',
    title: 'RFC lookup',
  })
})

test('a skill the account no longer publishes is gone', async () => {
  detail = { status: 404, body: 'Not found' }
  expect(
    clawhubSource.fetch({ name: 'rfc-lookup', discovered: 'auto' }, config()),
  ).rejects.toBeInstanceOf(Gone)
})
