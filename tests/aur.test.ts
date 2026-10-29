import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { aurSource } from '../src/sources/aur.ts'
import { Gone } from '../src/sources/types.ts'

const API = 'https://aur.archlinux.org/rpc/v5'

let dir: string
let requested: string[]
let routes: Record<string, () => Response>
const realFetch = globalThis.fetch

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })

const pkg = (Name: string, extra: Record<string, unknown> = {}) => ({
  Description: 'Small helper for OpenClaw TUI session management.',
  FirstSubmitted: 1776099295,
  ID: 2096122,
  LastModified: 1779915055,
  Maintainer: 'shbernal',
  Name,
  NumVotes: 5,
  OutOfDate: null,
  PackageBase: Name,
  PackageBaseID: 233861,
  Popularity: 0.000093,
  URL: 'https://github.com/shbernal/och',
  URLPath: `/cgit/aur.git/snapshot/${Name}.tar.gz`,
  Version: '1:0.1.8-2',
  ...extra,
})

const reply = (type: string, results: unknown[]) =>
  json({ resultcount: results.length, results, type, version: 5 })

const config = (include: string[] = []) => ({
  ...structuredClone(DEFAULT_CONFIG),
  accounts: { aur: 'shbernal' },
  include,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  routes = {
    [`${API}/search/shbernal?by=maintainer`]: () =>
      reply('search', [pkg('och'), pkg('och-git', { Version: '0.1.8.r3.gabc123-1' })]),
    [`${API}/search/shbernal?by=comaintainers`]: () =>
      reply('search', [
        pkg('amass', { Maintainer: 'someone', URL: 'https://owasp.org', OutOfDate: 1780000000 }),
      ]),
    [`${API}/info?arg[]=och`]: () => reply('multiinfo', [pkg('och')]),
    [`${API}/info?arg[]=yay&arg[]=missing`]: () =>
      reply('multiinfo', [pkg('yay', { Maintainer: 'jguer' })]),
    [`${API}/info?arg[]=gone`]: () => reply('multiinfo', []),
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

test('discovery reads both maintainer searches and batches the includes they miss', async () => {
  const found = await aurSource.discover(config(['aur:och', 'aur:yay', 'aur:missing', 'npm:x']))
  expect(found.map((d) => [d.name, d.discovered])).toEqual([
    ['och', 'auto'],
    ['och-git', 'auto'],
    ['amass', 'auto'],
    ['yay', 'config'],
  ])
  expect(requested).toHaveLength(3)
  expect(requested).toContain(`${API}/info?arg[]=yay&arg[]=missing`)
})

test('a discovered package costs nothing, and its upstream repo becomes a link', async () => {
  const [hinted] = await aurSource.discover(config())
  requested = []
  const { snapshot, detail } = await aurSource.fetch(hinted!, config())
  expect(requested).toEqual([])
  expect(snapshot.id).toBe('aur:och')
  expect(snapshot.url).toBe('https://aur.archlinux.org/packages/och')
  expect(snapshot.metrics).toEqual({
    votes: 5,
    popularity: 0.000093,
    version: '0.1.8',
    lastPublish: '2026-05-27T20:50:55.000Z',
    outOfDate: 'no',
  })
  expect(snapshot.links).toEqual(['gh:shbernal/och'])
  expect(detail).toEqual({ description: 'Small helper for OpenClaw TUI session management.' })
})

test('a VCS package has no release version, and a flag says when it went out of date', async () => {
  const [, vcs, flagged] = await aurSource.discover(config())
  expect((await aurSource.fetch(vcs!, config())).snapshot.metrics.version).toBeNull()
  const { snapshot } = await aurSource.fetch(flagged!, config())
  expect(snapshot.metrics.outOfDate).toBe('2026-05-28T20:26:40.000Z')
  expect(snapshot.links).toEqual([])
})

test('a fresh read asks info, and a package the AUR does not know is gone', async () => {
  const { snapshot } = await aurSource.fetch(
    { name: 'och', discovered: 'config', hint: pkg('och', { NumVotes: 1 }), fresh: true },
    config(),
  )
  expect(requested).toEqual([`${API}/info?arg[]=och`])
  expect(snapshot.metrics.votes).toBe(5)
  expect(aurSource.fetch({ name: 'gone', discovered: 'config' }, config())).rejects.toBeInstanceOf(
    Gone,
  )
})

test('an RPC error is a failure, not an empty roster', async () => {
  routes[`${API}/search/shbernal?by=maintainer`] = () =>
    json({ error: 'Too many package results.', resultcount: 0, results: [], type: 'error' })
  expect(aurSource.discover(config())).rejects.toThrow('Too many package results.')
})
