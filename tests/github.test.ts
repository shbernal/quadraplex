import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { writeReleases } from '../src/core/store.ts'
import { githubSource, resetTokenCache, type Repo } from '../src/sources/github.ts'

let dir: string
let requested: string[]
const realFetch = globalThis.fetch

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    full_name: 'shbernal/thing',
    html_url: 'https://github.com/shbernal/thing',
    stargazers_count: 12,
    forks_count: 3,
    open_issues_count: 2,
    pushed_at: '2026-08-20T00:00:00.000Z',
    default_branch: 'main',
    archived: false,
    fork: false,
    description: null,
    homepage: null,
    ...overrides,
  }
}

function config(overrides: Partial<Config> = {}): Config {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides }
}

const ISSUES = [
  {
    number: 1,
    title: 'a',
    html_url: 'u',
    created_at: 'c',
    updated_at: 'u',
    comments: 0,
    body: null,
    user: null,
    labels: [],
  },
  {
    number: 2,
    title: 'b',
    html_url: 'u',
    created_at: 'c',
    updated_at: 'u',
    comments: 0,
    body: null,
    user: null,
    labels: [],
    pull_request: {},
  },
]

const asset = (name: string, download_count: number) => ({ name, download_count })

const RELEASES = [
  {
    tag_name: 'v2.0.0-rc.1',
    html_url: 'r3',
    draft: false,
    prerelease: true,
    published_at: '2026-09-10T00:00:00Z',
    assets: [asset('tool-linux.tar.gz', 5)],
  },
  {
    tag_name: 'v1.4.0',
    html_url: 'r2',
    draft: false,
    prerelease: false,
    published_at: '2026-09-01T00:00:00Z',
    assets: [
      asset('tool-linux.tar.gz', 40),
      asset('tool-macos.tar.gz', 60),
      asset('SHA256SUMS', 900),
      asset('tool-linux.tar.gz.sig', 900),
    ],
  },
  {
    tag_name: 'v9.9.9',
    html_url: 'd',
    draft: true,
    prerelease: false,
    published_at: null,
    assets: [],
  },
  {
    tag_name: 'v1.0.0',
    html_url: 'r1',
    draft: false,
    prerelease: false,
    published_at: '2026-06-01T00:00:00Z',
    assets: [asset('tool-linux.tar.gz', 100)],
  },
]

let releases: unknown[]

const issueRequests = () => requested.filter((url) => url.includes('/issues'))
const releaseRequests = () => requested.filter((url) => url.includes('/releases'))

function answer(url: string, headers: Record<string, string> = {}): Response {
  const body = url.includes('/compare/')
    ? { ahead_by: 4 }
    : url.includes('/releases')
      ? releases
      : ISSUES
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function fetchOne(hint: Repo, cfg: Config) {
  return githubSource.fetch({ name: hint.full_name, discovered: 'auto', hint }, cfg)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  process.env.GITHUB_TOKEN = 'test-token'
  resetHttpCache()
  resetTokenCache()
  requested = []
  releases = []
  globalThis.fetch = (async (url: URL | string) => {
    requested.push(url.toString())
    return answer(url.toString())
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  delete process.env.GITHUB_TOKEN
  globalThis.fetch = realFetch
  resetTokenCache()
})

test('every repo snapshot records whether it is archived and whether it is a fork', async () => {
  const live = await fetchOne(repo(), config())
  expect(live.snapshot.metrics.archived).toBe('no')
  expect(live.snapshot.metrics.fork).toBe('no')

  const old = await fetchOne(repo({ archived: true }), config({ includeArchived: true }))
  expect(old.snapshot.metrics.archived).toBe('yes')
})

test('a repo the state will drop is snapshotted without spending a request on its issues', async () => {
  const archived = await fetchOne(repo({ archived: true }), config())
  expect(requested).toEqual([])
  // Still measured, so an unarchive is picked up rather than freezing the target.
  expect(archived.snapshot.metrics.stars).toBe(12)
  expect(archived.snapshot.fetchedAt).toBeTruthy()
  // The split was never counted, so it is reported unknown rather than zero.
  expect(archived.snapshot.metrics.openIssues).toBeNull()
  expect(archived.detail).toBeUndefined()

  await fetchOne(repo({ fork: true }), config())
  expect(requested).toEqual([])
})

test('the issue list is still read when the repo is one the state keeps', async () => {
  const kept = await fetchOne(repo(), config())
  expect(issueRequests()).toHaveLength(1)
  expect(kept.snapshot.metrics.openIssues).toBe(1)
  expect(kept.snapshot.metrics.openPRs).toBe(1)

  requested = []
  await fetchOne(repo({ archived: true }), config({ includeArchived: true }))
  expect(issueRequests()).toHaveLength(1)
})

test('an unchanged issue list keeps the split it was counted with', async () => {
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    requested.push(url.toString())
    const etag = (init?.headers as Record<string, string> | undefined)?.['if-none-match']
    if (etag) return new Response(null, { status: 304 })
    return answer(url.toString(), { etag: '"v1"' })
  }) as typeof fetch

  const first = await fetchOne(repo(), config())
  const second = await githubSource.fetch(
    { name: 'shbernal/thing', discovered: 'auto', hint: repo() },
    config(),
    first.snapshot,
  )
  expect(issueRequests()).toHaveLength(2)
  expect(second.snapshot.metrics.openIssues).toBe(1)
  expect(second.snapshot.metrics.openPRs).toBe(1)
  // The stored detail file is already the current list, so nothing overwrites it.
  expect(second.detail).toBeUndefined()
})

test('a split that was never counted is requested whole rather than carried over', async () => {
  const sent: (string | undefined)[] = []
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const etag = (init?.headers as Record<string, string> | undefined)?.['if-none-match']
    if (url.toString().includes('/issues')) sent.push(etag)
    if (etag) return new Response(null, { status: 304 })
    return answer(url.toString(), { etag: '"v1"' })
  }) as typeof fetch

  const first = await fetchOne(repo(), config())
  const lost = { ...first.snapshot, metrics: { ...first.snapshot.metrics, openPRs: null } }
  const second = await githubSource.fetch(
    { name: 'shbernal/thing', discovered: 'auto', hint: repo() },
    config(),
    lost,
  )
  expect(sent).toEqual([undefined, '"v1"', undefined])
  expect(second.snapshot.metrics.openPRs).toBe(1)
})

test('a repo that has released carries its latest version and every download bar checksums', async () => {
  releases = RELEASES
  const fetched = await fetchOne(repo(), config())
  expect(fetched.snapshot.metrics.version).toBe('1.4.0')
  expect(fetched.snapshot.metrics.lastPublish).toBe('2026-09-01T00:00:00Z')
  expect(fetched.snapshot.metrics.downloadsTotal).toBe(205)
  expect(fetched.releases!.count).toBe(3)
  expect(fetched.releases!.latest!.assets.map((a) => a.name)).toEqual([
    'tool-macos.tar.gz',
    'tool-linux.tar.gz',
  ])
})

test('a released repo counts the commits its default branch holds past the release tag', async () => {
  releases = RELEASES
  const fetched = await fetchOne(repo(), config())
  expect(fetched.snapshot.metrics.unreleasedCommits).toBe(4)
  expect(requested.find((url) => url.includes('/compare/'))).toContain('/compare/v1.4.0...main')

  globalThis.fetch = (async (url: URL | string) =>
    url.toString().includes('/compare/')
      ? new Response('{}', { status: 404 })
      : answer(url.toString())) as typeof fetch
  resetHttpCache()
  const gone = await fetchOne(
    repo({ pushed_at: new Date(Date.now() + 1000).toISOString() }),
    config(),
  )
  expect(gone.snapshot.metrics.unreleasedCommits).toBeNull()
})

test('a repo that never released carries no release metrics rather than zeros', async () => {
  const fetched = await fetchOne(repo(), config())
  expect(releaseRequests()).toHaveLength(1)
  expect('version' in fetched.snapshot.metrics).toBe(false)
  expect('downloadsTotal' in fetched.snapshot.metrics).toBe(false)
  expect('unreleasedCommits' in fetched.snapshot.metrics).toBe(false)
})

test('releases are reread once a day, and as soon as the repo is pushed again', async () => {
  releases = RELEASES
  const first = await fetchOne(repo(), config())
  writeReleases(first.releases!)
  const cached = await fetchOne(repo(), config())
  expect(releaseRequests()).toHaveLength(1)
  expect(cached.snapshot.metrics.downloadsTotal).toBe(205)

  await fetchOne(repo({ pushed_at: new Date(Date.now() + 1000).toISOString() }), config())
  expect(releaseRequests()).toHaveLength(2)
})
