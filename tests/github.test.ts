import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
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

function fetchOne(hint: Repo, cfg: Config) {
  return githubSource.fetch({ name: hint.full_name, discovered: 'auto', hint }, cfg)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_DATA_DIR = dir
  process.env.GITHUB_TOKEN = 'test-token'
  resetHttpCache()
  resetTokenCache()
  requested = []
  globalThis.fetch = (async (url: URL | string) => {
    requested.push(url.toString())
    return new Response(JSON.stringify(ISSUES), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_DATA_DIR
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
  expect(requested).toHaveLength(1)
  expect(kept.snapshot.metrics.openIssues).toBe(1)
  expect(kept.snapshot.metrics.openPRs).toBe(1)

  requested = []
  await fetchOne(repo({ archived: true }), config({ includeArchived: true }))
  expect(requested).toHaveLength(1)
})
