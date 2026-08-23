import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetHttpCache } from '../src/core/http.ts'
import { paths } from '../src/core/paths.ts'
import { readCurve, writeCurve } from '../src/core/store.ts'
import type { MetricValue } from '../src/core/types.ts'
import { curvesSummary, refreshCurves } from '../src/commands/curves.ts'
import { resetTokenCache } from '../src/sources/github.ts'

const DAY = 86_400_000
const ID = 'gh:o/r'
const realFetch = globalThis.fetch
let dir: string
let requests = 0

function seed(stars: MetricValue): void {
  const snapshot = {
    id: ID,
    ecosystem: 'github',
    name: 'o/r',
    url: 'https://github.com/o/r',
    discovered: 'auto',
    metrics: { stars },
    links: [],
    fetchedAt: new Date().toISOString(),
  }
  writeFileSync(paths.snapshots, `${JSON.stringify(snapshot)}\n`)
}

function answer(response: () => Response): void {
  globalThis.fetch = (async () => {
    requests++
    return response()
  }) as unknown as typeof fetch
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  process.env.GITHUB_TOKEN = 'test-token'
  resetHttpCache()
  resetTokenCache()
  requests = 0
  answer(() => Response.json([{ starred_at: '2026-08-01T00:00:00Z', user: { login: 'someone' } }]))
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  delete process.env.GITHUB_TOKEN
})

test('an unknown star count writes no curve and is reported apart', async () => {
  seed(null)
  const report = await refreshCurves()
  expect(report).toEqual({ built: [], skipped: 0, ttl: '30d', unknown: [ID], failed: [] })
  expect(existsSync(paths.curve(ID))).toBe(false)
  expect(requests).toBe(0)
})

test('a repo with no stars is skipped without a request', async () => {
  seed(0)
  expect((await refreshCurves()).skipped).toBe(1)
  expect(requests).toBe(0)
})

test('a curve inside its TTL is skipped and one past it is rebuilt', async () => {
  seed(1)
  writeCurve({ id: ID, fetchedAt: new Date(Date.now() - 60_000).toISOString(), points: [] })
  expect((await refreshCurves()).skipped).toBe(1)
  expect(requests).toBe(0)

  writeCurve({ id: ID, fetchedAt: new Date(Date.now() - 40 * DAY).toISOString(), points: [] })
  expect((await refreshCurves()).built).toEqual([ID])
  expect(readCurve(ID)!.points.length).toBeGreaterThan(0)
})

test('a curve that fails to build is reported rather than thrown', async () => {
  answer(() => new Response('gone', { status: 404, statusText: 'Not Found' }))
  seed(5)
  const report = await refreshCurves()
  expect(report.built).toEqual([])
  expect(report.failed.map((f) => f.id)).toEqual([ID])
})

test('the summary names the curve TTL in force', async () => {
  writeFileSync(paths.config, JSON.stringify({ ttl: { curves: '7d' } }))
  seed(0)
  expect(curvesSummary(await refreshCurves())).toContain('inside the 7d window')
})

test('a curve with an unreadable timestamp is rebuilt', async () => {
  seed(1)
  writeCurve({ id: ID, fetchedAt: 'yesterday', points: [] })
  expect((await refreshCurves()).built).toEqual([ID])
})
