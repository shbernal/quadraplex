import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/core/config.ts'
import { deriveState, readSeries, readSnapshots } from '../src/core/store.ts'
import { refresh } from '../src/commands/refresh.ts'
import { sources } from '../src/sources/registry.ts'
import { githubRepoFromUrl, sumLast, type Source } from '../src/sources/types.ts'
import { resetHttpCache } from '../src/core/http.ts'

let dir: string
const realNpm = sources.npm!
const realPypi = sources.pypi!

function stub(behaviour: (name: string) => Promise<never> | null, downloads = 10): Source {
  return {
    ecosystem: 'npm',
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_DATA_DIR = dir
  resetHttpCache()
  sources.pypi = {
    ecosystem: 'pypi',
    discover: async () => [],
    fetch: async () => {
      throw new Error('unused')
    },
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_DATA_DIR
  sources.npm = realNpm
  sources.pypi = realPypi
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
})

test('excluded targets are never fetched', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ exclude: ['npm:bad'] }))
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
