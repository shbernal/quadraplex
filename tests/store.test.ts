import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG, loadConfig } from '../src/core/config.ts'
import { computeDeltas } from '../src/core/deltas.ts'
import {
  appendSnapshots,
  deriveState,
  readCache,
  readSnapshots,
  readCurve,
  readSeries,
  rebuildState,
  writeSeries,
} from '../src/core/store.ts'
import { fileName, paths } from '../src/core/paths.ts'
import type { MetricValue, Snapshot } from '../src/core/types.ts'

let dir: string

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-08-23T12:00:00.000Z')

function snap(id: string, at: number, metrics: Record<string, MetricValue>): Snapshot {
  return {
    id,
    ecosystem: id.startsWith('gh:') ? 'github' : id.startsWith('pypi:') ? 'pypi' : 'npm',
    name: id.slice(id.indexOf(':') + 1),
    url: `https://example.test/${id}`,
    discovered: 'auto',
    metrics,
    links: [],
    fetchedAt: new Date(at).toISOString(),
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
})

test('a missing config yields the defaults and a missing store yields no targets', () => {
  expect(loadConfig()).toEqual(DEFAULT_CONFIG)
  expect(readSnapshots()).toEqual([])
  expect(deriveState(loadConfig(), NOW).targets).toEqual([])
})

test('deltas are null, not zero, when nothing predates the window', () => {
  const history = [
    snap('npm:a', NOW - HOUR, { downloadsWeek: 10 }),
    snap('npm:a', NOW, { downloadsWeek: 12 }),
  ]
  expect(computeDeltas(history[1]!, history, DAY).deltas).toBeNull()
})

test('the baseline is the newest snapshot at least one window older', () => {
  const history = [
    snap('npm:a', NOW - 5 * DAY, { downloadsWeek: 1 }),
    snap('npm:a', NOW - 3 * DAY, { downloadsWeek: 5 }),
    snap('npm:a', NOW - 2 * HOUR, { downloadsWeek: 40 }),
    snap('npm:a', NOW, { downloadsWeek: 42 }),
  ]
  const result = computeDeltas(history[3]!, history, DAY)
  expect(result.deltas).toEqual({ downloadsWeek: 37 })
  expect(result.deltaBaselineAt).toBe(history[1]!.fetchedAt)
})

test('a metric absent from the baseline gets a null delta rather than its own value', () => {
  const history = [
    snap('npm:a', NOW - 2 * DAY, { downloadsWeek: 5 }),
    snap('npm:a', NOW, { downloadsWeek: 9, stars: 3 }),
  ]
  expect(computeDeltas(history[1]!, history, DAY).deltas).toEqual({
    downloadsWeek: 4,
    stars: null,
  })
})

test('state.json regenerates from a multi-snapshot log and keeps only the latest per target', () => {
  const lines = [
    snap('npm:a', NOW - 3 * DAY, { downloadsWeek: 100 }),
    snap('gh:o/a', NOW - 3 * DAY, { stars: 4 }),
    snap('npm:a', NOW - 2 * DAY, { downloadsWeek: 140 }),
    snap('npm:a', NOW - 30 * 1000, { downloadsWeek: 180 }),
    snap('gh:o/a', NOW - 30 * 1000, { stars: 9 }),
  ]
  writeFileSync(paths.snapshots, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))

  const state = rebuildState(loadConfig(), NOW)
  expect(state.targets.map((t) => t.id)).toEqual(['gh:o/a', 'npm:a'])

  const npmTarget = state.targets.find((t) => t.id === 'npm:a')!
  expect(npmTarget.metrics.downloadsWeek).toBe(180)
  expect(npmTarget.deltas).toEqual({ downloadsWeek: 40 })
  expect(npmTarget.deltaBaselineAt).toBe(lines[2]!.fetchedAt)
  expect(npmTarget.stale).toBe(false)

  const reread = deriveState(loadConfig(), NOW)
  expect(reread).toEqual(state)
})

test('staleness comes from the per-ecosystem TTL, one hour for github and a day for npm', () => {
  appendSnapshots([
    snap('npm:a', NOW - 2 * HOUR, { downloadsWeek: 1 }),
    snap('gh:o/a', NOW - 2 * HOUR, { stars: 1 }),
  ])
  const state = deriveState(loadConfig(), NOW)
  expect(state.targets.find((t) => t.id === 'npm:a')!.stale).toBe(false)
  expect(state.targets.find((t) => t.id === 'gh:o/a')!.stale).toBe(true)
})

test('excluded targets never reach state.json', () => {
  appendSnapshots([
    snap('npm:a', NOW, { downloadsWeek: 1 }),
    snap('npm:b', NOW, { downloadsWeek: 1 }),
  ])
  writeFileSync(paths.config, JSON.stringify({ exclude: ['npm:b'] }))
  expect(deriveState(loadConfig(), NOW).targets.map((t) => t.id)).toEqual(['npm:a'])
})

test('archived repos and forks are dropped from state.json, and config puts them back', () => {
  appendSnapshots([
    snap('gh:o/live', NOW, { stars: 1, archived: 'no', fork: 'no' }),
    snap('gh:o/old', NOW, { stars: 2, archived: 'yes', fork: 'no' }),
    snap('gh:o/forked', NOW, { stars: 3, archived: 'no', fork: 'yes' }),
  ])
  expect(deriveState(loadConfig(), NOW).targets.map((t) => t.id)).toEqual(['gh:o/live'])

  writeFileSync(paths.config, JSON.stringify({ includeArchived: true, includeForks: true }))
  expect(deriveState(loadConfig(), NOW).targets.map((t) => t.id)).toEqual([
    'gh:o/forked',
    'gh:o/live',
    'gh:o/old',
  ])
})

test('a dropped repo keeps its history, so unarchiving restores its deltas', () => {
  appendSnapshots([
    snap('gh:o/old', NOW - DAY, { stars: 2, archived: 'yes', fork: 'no' }),
    snap('gh:o/old', NOW, { stars: 5, archived: 'no', fork: 'no' }),
  ])
  expect(readSnapshots()).toHaveLength(2)
  const target = deriveState(loadConfig(), NOW).targets.find((t) => t.id === 'gh:o/old')
  expect(target?.deltas?.stars).toBe(3)
})

test('the archived and fork flags only ever hide github targets', () => {
  appendSnapshots([snap('npm:a', NOW, { downloadsWeek: 1, archived: 'yes', fork: 'yes' })])
  expect(deriveState(loadConfig(), NOW).targets.map((t) => t.id)).toEqual(['npm:a'])
})

test('deprecated packages are dropped from state.json, and config puts them back', () => {
  appendSnapshots([
    snap('npm:live', NOW, { downloadsWeek: 1, deprecated: 'no' }),
    snap('npm:retired', NOW, { downloadsWeek: 2, deprecated: 'yes' }),
    // A repo carrying the flag is not a package, so it is unaffected by it.
    snap('gh:o/repo', NOW, { stars: 1, deprecated: 'yes', archived: 'no', fork: 'no' }),
  ])
  expect(deriveState(loadConfig(), NOW).targets.map((t) => t.id)).toEqual(['gh:o/repo', 'npm:live'])

  writeFileSync(paths.config, JSON.stringify({ includeDeprecated: true }))
  expect(deriveState(loadConfig(), NOW).targets.map((t) => t.id)).toEqual([
    'gh:o/repo',
    'npm:live',
    'npm:retired',
  ])
})

test('an unreadable line is skipped and the rest of the history survives', () => {
  const a = JSON.stringify(snap('npm:a', NOW, { downloadsWeek: 1 }))
  const b = JSON.stringify(snap('npm:b', NOW, { downloadsWeek: 2 }))
  writeFileSync(paths.snapshots, `${a}\n{"id":"npm:c","ecos\n\n${b}\n`)
  expect(readSnapshots().map((s) => s.id)).toEqual(['npm:a', 'npm:b'])
  expect(deriveState(loadConfig(), NOW).targets.map((t) => t.id)).toEqual(['npm:a', 'npm:b'])
})

test('an append after a torn line starts a line of its own', () => {
  writeFileSync(paths.snapshots, '{"id":"npm:c","ecos')
  appendSnapshots([snap('npm:a', NOW, { downloadsWeek: 1 })])
  expect(readSnapshots().map((s) => s.id)).toEqual(['npm:a'])
})

test('a damaged derived file reads as missing', () => {
  writeFileSync(paths.cache, '{"https://')
  mkdirSync(dirname(paths.curve('gh:o/r')), { recursive: true })
  writeFileSync(paths.curve('gh:o/r'), '{')
  expect(readCache()).toEqual({})
  expect(readCurve('gh:o/r')).toBeNull()
})

test('a snapshot with an unreadable fetchedAt is stale, not fresh forever', () => {
  appendSnapshots([{ ...snap('npm:a', NOW, { downloadsWeek: 1 }), fetchedAt: 'yesterday' }])
  expect(deriveState(loadConfig(), NOW).targets[0]!.stale).toBe(true)
})

test('ids that differ only in punctuation get distinct files', () => {
  expect(fileName('npm:@a/b')).toBe('npm_3a_40a_2fb')
  expect(fileName('npm:@a/b')).not.toBe(fileName('npm:_a_b'))
  writeSeries('npm:@a/b', [{ date: '2026-01-01', downloads: 1 }])
  expect(readSeries('npm:_a_b')).toEqual([])
})
