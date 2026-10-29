import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountFlags, foundText, suggest, writeAccounts } from '../src/commands/init.ts'
import { run } from '../src/cli.ts'
import { UsageError } from '../src/core/args.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { resetTokenCache } from '../src/sources/github.ts'

let dir: string
let requested: string[]
const realFetch = globalThis.fetch
const saved = { ...process.env }

/** Answers by path: a body is a 200, a number is that status with no body. */
let routes: Record<string, unknown>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  process.env.GH_CONFIG_DIR = dir
  process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GITHUB_TOKEN = 'test-token'
  resetHttpCache()
  resetTokenCache()
  requested = []
  routes = {}
  globalThis.fetch = (async (url: URL | string) => {
    const path = new URL(url.toString()).pathname
    requested.push(path)
    const answer = routes[path]
    if (answer === undefined || typeof answer === 'number') {
      return new Response(null, { status: answer ?? 404 })
    }
    return Response.json(answer)
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  globalThis.fetch = realFetch
  process.env = { ...saved }
})

test('the handle comes from gh first, then git github.user, and --handle overrides both', async () => {
  writeFileSync(
    join(dir, 'gitconfig'),
    '[github]\n\tuser = from-git\n[user]\n\tname = Display Name\n',
  )
  routes['/users/from-git'] = { public_repos: 2 }
  routes['/users/from-gh'] = { public_repos: 5 }
  routes['/users/typed'] = { public_repos: 1 }

  const viaGit = (await suggest({ only: 'gh' })).suggestions[0]!
  expect(viaGit).toMatchObject({ value: 'from-git', source: 'git', status: 'found', count: 2 })

  writeFileSync(
    join(dir, 'hosts.yml'),
    'github.com:\n    users:\n        from-gh:\n    git_protocol: ssh\n    user: from-gh\n',
  )
  expect((await suggest({ only: 'gh' })).suggestions[0]).toMatchObject({ source: 'gh', count: 5 })
  expect((await suggest({ only: 'gh', handle: 'typed' })).suggestions[0]).toMatchObject({
    source: 'handle',
    value: 'typed',
  })
})

test('with nothing detected every row is empty and nothing is requested', async () => {
  const { suggestions } = await suggest({})
  expect(suggestions.map((s) => s.ecosystem)).toEqual([
    'npm',
    'pypi',
    'github',
    'ghcr',
    'amo',
    'cws',
    'clawhub',
    'dockerhub',
    'rubygems',
  ])
  expect(suggestions.every((s) => s.value === null && s.status === 'none')).toBe(true)
  expect(requested).toEqual([])
})

test('an AMO handle resolves to the numeric id discovery keys on, named for the reader', async () => {
  routes['/api/v5/accounts/account/me/'] = { id: 42, name: 'Me', num_addons_listed: 3 }
  const [amo] = (await suggest({ only: 'amo', amo: 'me' })).suggestions
  expect(amo).toEqual({
    ecosystem: 'amo',
    value: '42',
    source: 'typed',
    status: 'found',
    count: 3,
    label: 'Me',
  })
  expect(foundText(amo!)).toBe('3 add-ons')
})

const author = (id: number, name: string) => ({ authors: [{ id, name }] })

test('an AMO handle without a username is matched once by display name, and says so', async () => {
  routes['/api/v5/addons/search/'] = { results: [author(7, 'other'), author(42, 'ME')] }
  routes['/api/v5/accounts/account/42/'] = { id: 42, name: 'Me', num_addons_listed: 3 }
  const [amo] = (await suggest({ only: 'amo', amo: 'me' })).suggestions
  expect(amo).toMatchObject({ value: '42', status: 'found', label: 'Me, by display name' })

  routes['/api/v5/addons/search/'] = { results: [author(42, 'Me'), author(43, 'me')] }
  const [ambiguous] = (await suggest({ only: 'amo', amo: 'me' })).suggestions
  expect(ambiguous).toMatchObject({ value: 'me', status: 'none' })
})

test('an unknown account is none, an unreachable registry is unchecked with the reason', async () => {
  routes['/users/ghost'] = 404
  routes['/users/flaky'] = 400
  const [ghost] = (await suggest({ only: 'gh', github: 'ghost' })).suggestions
  expect(ghost).toMatchObject({ status: 'none', count: 0 })
  expect(foundText(ghost!)).toBe('nothing found')

  const [flaky] = (await suggest({ only: 'gh', github: 'flaky' })).suggestions
  expect(flaky!.status).toBe('unchecked')
  expect(foundText(flaky!)).toStartWith("couldn't check: 400")
})

test('accounts merge into the config, an empty value removes one, other keys stay', () => {
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify({ accounts: { npm: 'old', cws: 'c' }, include: ['npm:x'] }))
  writeAccounts(accountFlags({ npm: 'new', github: ' me ', cws: '', json: true })!)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    accounts: { npm: 'new', github: 'me' },
    include: ['npm:x'],
  })
  expect(readdirSync(dir)).toEqual(['config.json'])
})

test('a config that does not validate is left as it was', () => {
  const file = join(dir, 'config.json')
  writeFileSync(file, '{"includeForks": "yes"}')
  expect(() => writeAccounts({ npm: 'me' })).toThrow('includeForks')
  expect(readFileSync(file, 'utf8')).toBe('{"includeForks": "yes"}')
})

test('init with no account flag and no --suggest is a usage error', async () => {
  expect(run(['init'])).rejects.toBeInstanceOf(UsageError)
})
