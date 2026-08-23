import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageError } from '../src/core/args.ts'
import { flushCache, resetHttpCache } from '../src/core/http.ts'
import { paths } from '../src/core/paths.ts'
import { loadConfig } from '../src/core/config.ts'
import { appendSnapshots, readDetail, readSnapshots, writeReleases } from '../src/core/store.ts'
import { targetPayload } from '../src/commands/target.ts'
import { githubSource, resetTokenCache } from '../src/sources/github.ts'
import { sources } from '../src/sources/all.ts'

let dir: string
let requests: { url: string; etag: string | null }[]
let respond: (url: string, etag: string | null) => Response
let releases: unknown[]
const realFetch = globalThis.fetch
const realSources = { ...sources }

const REPO = {
  full_name: 'a/b',
  html_url: 'https://github.com/a/b',
  stargazers_count: 12,
  forks_count: 3,
  open_issues_count: 0,
  pushed_at: '2026-08-20T00:00:00.000Z',
  default_branch: 'main',
  archived: false,
  fork: false,
  description: null,
  homepage: null,
}

function json(body: unknown, etag = '"v1"'): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', etag },
  })
}

/** Answers 304 whenever the client presents the ETag it was given, like GitHub does. */
function conditional(body: unknown) {
  return (_url: string, etag: string | null) =>
    etag === '"v1"' ? new Response(null, { status: 304 }) : json(body)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  process.env.GITHUB_TOKEN = 'test-token'
  resetHttpCache()
  resetTokenCache()
  requests = []
  respond = conditional(REPO)
  releases = []
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const etag = (init!.headers as Record<string, string>)['if-none-match'] ?? null
    requests.push({ url: url.toString(), etag })
    return url.toString().includes('/releases?') ? json(releases) : respond(url.toString(), etag)
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  delete process.env.GITHUB_TOKEN
  globalThis.fetch = realFetch
  Object.assign(sources, realSources)
})

/** The routine path, which is the one a 304 may answer. Persists ETags as refresh does. */
async function routine(previous?: Parameters<typeof githubSource.fetch>[2]) {
  const fetched = await githubSource.fetch(
    { name: 'a/b', discovered: 'auto' },
    loadConfig(),
    previous,
  )
  flushCache()
  return fetched
}

test('--fresh asks unconditionally, so a 304 never answers with the previous snapshot', async () => {
  await targetPayload('github', 'a/b', true)
  resetHttpCache()
  await targetPayload('github', 'a/b', true)
  expect(requests.every((r) => r.etag === null)).toBe(true)
})

test('--fresh rereads releases a refresh read before the release existed', async () => {
  writeReleases({
    id: 'gh:a/b',
    fetchedAt: new Date().toISOString(),
    latest: { tag: 'v0.2.2', url: 'u', publishedAt: '2026-08-01T00:00:00Z', assets: [] },
    downloads: 0,
    count: 1,
    ahead: null,
  })
  releases = [
    { tag_name: 'v0.3.0', html_url: 'u', published_at: '2026-08-20T00:00:02Z', assets: [] },
    { tag_name: 'v0.2.2', html_url: 'u', published_at: '2026-08-01T00:00:00Z', assets: [] },
  ]
  expect((await routine()).snapshot.metrics.version).toBe('0.2.2')
  const payload = await targetPayload('github', 'a/b', true)
  expect(payload.target.metrics.version).toBe('0.3.0')
})

test('a routine fetch inside the ETag window answers the 304 from the stored snapshot', async () => {
  const first = (await routine()).snapshot
  resetHttpCache()
  const second = (await routine(first)).snapshot
  expect(requests.at(-1)!.etag).toBe('"v1"')
  expect(second.metrics).toEqual(first.metrics)
})

test('an ETag with no snapshot behind it is a cache miss, not an error', async () => {
  writeFileSync(
    join(dir, 'cache.json'),
    JSON.stringify({ 'https://api.github.com/repos/a/b': { etag: '"v1"', fetchedAt: 'x' } }),
  )
  const { snapshot } = await routine()
  expect(snapshot.metrics.stars).toBe(12)
  expect(requests.map((r) => r.etag)).toEqual(['"v1"', null, null, null])
})

test('an archived repo says which setting hides it instead of crashing', async () => {
  respond = conditional({ ...REPO, archived: true })
  const error = await targetPayload('github', 'a/b', true).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(UsageError)
  expect((error as Error).message).toContain('includeArchived')
})

test('AMO resolving an old slug to the canonical one returns the canonical target', async () => {
  respond = () =>
    json({
      slug: 'new-slug',
      guid: 'g',
      url: 'https://addons.mozilla.org/addon/new-slug/',
      name: 'Thing',
      average_daily_users: 5,
      last_updated: '2026-08-07T09:45:32Z',
    })
  const payload = await targetPayload('amo', 'old-slug', true)
  expect(payload.target.id).toBe('amo:new-slug')
  expect(payload.target.metrics.users).toBe(5)
})

test('a 304 after a failed attempt drops the failure it recovered from', async () => {
  const stored = (await routine()).snapshot
  resetHttpCache()
  const { snapshot } = await routine({
    ...stored,
    attemptedAt: stored.fetchedAt,
    errors: ['429 nope'],
  })
  expect(requests.at(-1)!.etag).toBe('"v1"')
  expect(snapshot.errors).toBeUndefined()
  expect(snapshot.attemptedAt).toBeUndefined()
})

test('--fresh keeps how a target was discovered', async () => {
  await targetPayload('github', 'a/b', true)
  const [stored] = readSnapshots()
  writeFileSync(paths.snapshots, `${JSON.stringify({ ...stored, discovered: 'auto' })}\n`)
  writeFileSync(join(dir, 'cache.json'), '{}')
  resetHttpCache()
  await targetPayload('github', 'a/b', true)
  expect(readSnapshots().at(-1)!.discovered).toBe('auto')
})

test('--fresh persists the detail it fetched, so the dashboard reads the same one', async () => {
  sources.npm = {
    ecosystem: 'npm',
    roster: true,
    discover: async () => [],
    fetch: async (descriptor) => ({
      snapshot: {
        id: `npm:${descriptor.name}`,
        ecosystem: 'npm',
        name: descriptor.name,
        url: `https://www.npmjs.com/package/${descriptor.name}`,
        discovered: descriptor.discovered,
        metrics: {},
        links: [],
        fetchedAt: new Date().toISOString(),
      },
      detail: { issues: ['fresh'] },
    }),
  }
  await targetPayload('npm', 'pkg', true)
  expect(readDetail('npm:pkg')).toEqual({ issues: ['fresh'] })
})

test('a retired target is explained rather than reported missing', async () => {
  appendSnapshots([
    {
      id: 'cws:abcdefghijklmnopabcdefghijklmnop',
      ecosystem: 'cws',
      name: 'abcdefghijklmnopabcdefghijklmnop',
      url: 'https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop',
      discovered: 'auto',
      metrics: {},
      links: [],
      fetchedAt: '2026-09-01T00:00:00Z',
      retired: { at: '2026-10-02T00:00:00Z', reason: 'no store listing' },
    },
  ])
  expect(targetPayload('cws', 'abcdefghijklmnopabcdefghijklmnop', false)).rejects.toThrow(
    'retired 2026-10-02: no store listing',
  )
})
