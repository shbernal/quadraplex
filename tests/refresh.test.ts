import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageError } from '../src/core/args.ts'
import { loadConfig } from '../src/core/config.ts'
import { deriveState, readSeries, readSnapshots } from '../src/core/store.ts'
import { parseOnly, refresh, refreshSummary } from '../src/commands/refresh.ts'
import { sources } from '../src/sources/all.ts'
import {
  githubRepoFromUrl,
  Gone,
  PartialDiscovery,
  sumLast,
  type Descriptor,
  type Source,
} from '../src/sources/types.ts'
import { resetHttpCache } from '../src/core/http.ts'

let dir: string
const real = { ...sources }

function stub(behaviour: (name: string) => Promise<never> | null, downloads = 10): Source {
  return {
    ecosystem: 'npm',
    roster: true,
    discover: async () => [
      { name: 'good', discovered: 'auto' },
      { name: 'bad', discovered: 'auto' },
    ],
    fetch: async (descriptor) => {
      const failure = behaviour(descriptor.name)
      if (failure) await failure
      return {
        snapshot: {
          id: `npm:${descriptor.name}`,
          ecosystem: 'npm',
          name: descriptor.name,
          url: `https://www.npmjs.com/package/${descriptor.name}`,
          discovered: descriptor.discovered,
          metrics: { downloadsWeek: downloads },
          links: [],
          fetchedAt: new Date().toISOString(),
        },
        series: [{ date: '2026-08-22', downloads }],
      }
    },
  }
}

function configure(extra: object = {}): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ accounts: { npm: 'you' }, ...extra }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  configure()
  resetHttpCache()
  sources.pypi = {
    ecosystem: 'pypi',
    roster: true,
    discover: async () => [],
    fetch: async () => {
      throw new Error('unused')
    },
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  Object.assign(sources, real)
})

test('a refresh appends one snapshot per target and writes its series', async () => {
  sources.npm = stub(() => null, 42)
  const report = await refresh({ only: 'npm' })
  expect(report.ok).toBe(2)
  expect(report.failed).toEqual([])
  expect(
    readSnapshots()
      .map((s) => s.id)
      .toSorted(),
  ).toEqual(['npm:bad', 'npm:good'])
  expect(readSeries('npm:good')).toEqual([{ date: '2026-08-22', downloads: 42 }])
})

test('a target that fails keeps its values, its fetchedAt and gains an error', async () => {
  sources.npm = stub(() => null, 10)
  await refresh({ only: 'npm' })
  const first = readSnapshots().find((s) => s.id === 'npm:bad')!

  sources.npm = stub((name) => (name === 'bad' ? Promise.reject(new Error('503 nope')) : null), 99)
  const report = await refresh({ only: 'npm' })

  expect(report.ok).toBe(1)
  expect(report.failed).toEqual([{ id: 'npm:bad', error: '503 nope' }])

  const bad = deriveState(loadConfig()).targets.find((t) => t.id === 'npm:bad')!
  expect(bad.metrics.downloadsWeek).toBe(10)
  expect(bad.fetchedAt).toBe(first.fetchedAt)
  expect(bad.errors).toEqual(['503 nope'])
  expect(bad.attemptedAt).toBeString()

  const good = deriveState(loadConfig()).targets.find((t) => t.id === 'npm:good')!
  expect(good.metrics.downloadsWeek).toBe(99)
  expect(good.errors).toBeUndefined()

  sources.npm = stub(() => null, 100)
  await refresh({ only: 'npm' })
  const recovered = deriveState(loadConfig()).targets.find((t) => t.id === 'npm:bad')!
  expect(recovered.errors).toBeUndefined()
  expect(recovered.attemptedAt).toBeUndefined()
})

test('with no account and no include there is nothing to refresh', async () => {
  configure({ accounts: {} })
  expect(refresh({ only: 'npm' })).rejects.toThrow('qplex init')
})

test('excluded targets are never fetched', async () => {
  configure({ exclude: ['npm:bad'] })
  sources.npm = stub(() => null)
  const report = await refresh({ only: 'npm' })
  expect(report.ok).toBe(1)
  expect(readSnapshots().map((s) => s.id)).toEqual(['npm:good'])
})

test('a repo link is recovered from any GitHub url shape a registry carries', () => {
  expect(githubRepoFromUrl('git+https://github.com/shbernal/charcheck.git')).toBe(
    'shbernal/charcheck',
  )
  expect(githubRepoFromUrl('https://github.com/shbernal/gitpulse#readme')).toBe('shbernal/gitpulse')
  expect(githubRepoFromUrl('git@github.com:shbernal/och.git')).toBe('shbernal/och')
  expect(githubRepoFromUrl('https://gitlab.com/x/y')).toBeNull()
  expect(githubRepoFromUrl(undefined)).toBeNull()
})

test('download windows sum the tail of the series', () => {
  const series = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, downloads: i }))
  expect(sumLast(series, 7)).toBe(33 + 34 + 35 + 36 + 37 + 38 + 39)
  expect(sumLast(series, 500)).toBe(780)
})

test('a failed discovery keeps the other ecosystems and refetches what the store knows', async () => {
  sources.npm = stub(() => null, 5)
  await refresh({ only: 'npm' })

  sources.npm = { ...stub(() => null, 7), discover: () => Promise.reject(new Error('404 no user')) }
  sources.pypi = {
    ecosystem: 'pypi',
    roster: true,
    discover: async () => [{ name: 'py', discovered: 'auto' }],
    fetch: async (descriptor) => ({
      snapshot: {
        id: `pypi:${descriptor.name}`,
        ecosystem: 'pypi',
        name: descriptor.name,
        url: `https://pypi.org/project/${descriptor.name}/`,
        discovered: descriptor.discovered,
        metrics: { downloadsWeek: 3 },
        links: [],
        fetchedAt: new Date().toISOString(),
      },
    }),
  }
  const quiet: Source = { ...stub(() => null), discover: async () => [] }
  sources.github = quiet
  sources.amo = quiet
  sources.cws = quiet
  const report = await refresh({ only: undefined })

  expect(report.discoveryFailed).toEqual([{ ecosystem: 'npm', error: '404 no user' }])
  expect(refreshSummary(report)).toContain('discovery failed for npm')
  const targets = deriveState(loadConfig()).targets
  expect(targets.find((t) => t.id === 'npm:good')!.metrics.downloadsWeek).toBe(7)
  expect(targets.find((t) => t.id === 'pypi:py')!.metrics.downloadsWeek).toBe(3)
})

const visible = () => deriveState(loadConfig()).targets.map((t) => t.id)

/** A stub whose discovery returns `names` and which records every fetch. */
function listing(names: string[], roster: boolean, fetched: string[], gone: string[] = []): Source {
  const base = stub((name) => {
    fetched.push(name)
    return gone.includes(name) ? Promise.reject(new Gone(`${name} is gone`)) : null
  })
  return {
    ...base,
    roster,
    discover: async () => names.map((name): Descriptor => ({ name, discovered: 'auto' })),
  }
}

test('a target missing from a full roster is retired without a request', async () => {
  sources.npm = stub(() => null, 10)
  await refresh({ only: 'npm' })

  const fetched: string[] = []
  sources.npm = listing(['good'], true, fetched)
  const report = await refresh({ only: 'npm' })

  expect(fetched).toEqual(['good'])
  expect(report.retired).toEqual([{ id: 'npm:bad', reason: 'no longer listed for you' }])
  expect(refreshSummary(report)).toContain('retired npm:bad: no longer listed for you')
  expect(visible()).toEqual(['npm:good'])
  // The log keeps the last values seen, and the target is not asked about again.
  const tomb = readSnapshots().findLast((s) => s.id === 'npm:bad')!
  expect(tomb.metrics.downloadsWeek).toBe(10)
  expect(tomb.retired!.at).toBeString()
  const again = await refresh({ only: 'npm' })
  expect(again.retired).toEqual([])
  expect(fetched).toEqual(['good', 'good'])
})

test('a target missing from a search is fetched, and retired only when answered gone', async () => {
  sources.npm = stub(() => null)
  await refresh({ only: 'npm' })

  const fetched: string[] = []
  sources.npm = listing([], false, fetched, ['bad'])
  const report = await refresh({ only: 'npm' })

  expect(fetched.toSorted()).toEqual(['bad', 'good'])
  expect(report.retired).toEqual([{ id: 'npm:bad', reason: 'bad is gone' }])
  expect(report.failed).toEqual([])
  expect(visible()).toEqual(['npm:good'])
})

test('a partial discovery retires nothing and fetches what it found plus what is known', async () => {
  sources.npm = stub(() => null)
  await refresh({ only: 'npm' })

  const fetched: string[] = []
  sources.npm = {
    ...listing([], true, fetched),
    discover: async () => {
      throw new PartialDiscovery([{ name: 'new', discovered: 'auto' }], 'roster unreadable')
    },
  }
  const report = await refresh({ only: 'npm' })

  expect(report.retired).toEqual([])
  expect(report.discoveryFailed).toEqual([{ ecosystem: 'npm', error: 'roster unreadable' }])
  expect(fetched.toSorted()).toEqual(['bad', 'good', 'new'])
})

test('a retired target that discovery finds again comes back', async () => {
  sources.npm = stub(() => null)
  await refresh({ only: 'npm' })
  sources.npm = listing(['good'], true, [])
  await refresh({ only: 'npm' })
  expect(visible()).toEqual(['npm:good'])

  sources.npm = listing(['good', 'bad'], true, [])
  await refresh({ only: 'npm' })
  expect(visible()).toEqual(['npm:bad', 'npm:good'])
})

test('a gone include entry is retired once and kept being asked', async () => {
  configure({ include: ['npm:bad'] })
  sources.npm = stub(() => null)
  await refresh({ only: 'npm' })

  const fetched: string[] = []
  sources.npm = listing(['good'], true, fetched, ['bad'])
  expect((await refresh({ only: 'npm' })).retired.map((r) => r.id)).toEqual(['npm:bad'])
  const again = await refresh({ only: 'npm' })
  expect(again.retired).toEqual([])
  expect(again.failed).toEqual([])
  expect(fetched.filter((name) => name === 'bad')).toHaveLength(2)
  expect(visible()).toEqual(['npm:good'])
})

test('a gone target the store never saw is a failure, there being nothing to retire', async () => {
  configure({ include: ['npm:typo'] })
  sources.npm = listing(['good'], true, [], ['typo'])
  const report = await refresh({ only: 'npm' })
  expect(report.retired).toEqual([])
  expect(report.failed).toEqual([{ id: 'npm:typo', error: 'typo is gone' }])
})

test('--only accepts an ecosystem or an alias, and defaults to every registered source', () => {
  expect(parseOnly('gh')).toEqual(['github'])
  expect(parseOnly('pypi')).toEqual(['pypi'])
  expect(parseOnly('docker')).toEqual(['dockerhub'])
  expect(parseOnly('gem')).toEqual(['rubygems'])
  expect(parseOnly(undefined)).toEqual([
    'npm',
    'pypi',
    'github',
    'ghcr',
    'amo',
    'cws',
    'clawhub',
    'dockerhub',
    'rubygems',
    'jsr',
    'vscode',
    'openvsx',
    'aur',
  ])
  expect(() => parseOnly('crates')).toThrow('--only takes one of')
  delete sources.cws
  expect(() => parseOnly('cws')).toThrow(UsageError)
})

test('past the run deadline no target starts and known ones carry forward as failed', async () => {
  sources.npm = stub(() => null, 5)
  await refresh({ only: 'npm' })

  let discovered = false
  sources.npm = {
    ...stub(() => null, 9),
    discover: async () => {
      discovered = true
      return []
    },
  }
  const report = await refresh({ only: 'npm', deadlineMs: 0 })
  expect(discovered).toBe(false)
  expect(report.ok).toBe(0)
  expect(report.failed.map((f) => f.id).toSorted()).toEqual(['npm:bad', 'npm:good'])
  const good = deriveState(loadConfig()).targets.find((t) => t.id === 'npm:good')!
  expect(good.metrics.downloadsWeek).toBe(5)
  expect(good.errors).toEqual(['refresh deadline reached, not fetched'])
})
