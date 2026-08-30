import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendSnapshots } from '../src/core/store.ts'
import { buildProjects } from '../src/tui/model.ts'
import type { Ecosystem, MetricValue, Snapshot } from '../src/core/types.ts'

let dir: string

function snap(
  id: string,
  ecosystem: Ecosystem,
  metrics: Record<string, MetricValue>,
  links: string[] = [],
): Snapshot {
  return {
    id,
    ecosystem,
    name: id.slice(id.indexOf(':') + 1),
    url: `https://example.test/${id}`,
    discovered: 'auto',
    metrics,
    links,
    fetchedAt: new Date().toISOString(),
  }
}

function store(snapshots: Snapshot[], config: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  appendSnapshots(snapshots)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_DATA_DIR = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_DATA_DIR
})

test('an extension on both stores reports the Chrome bucket, marked as one', () => {
  store([
    snap('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', { users: '1,000', title: 'Blocker' }, [
      'gh:owner/blocker',
    ]),
    snap('amo:blocker', 'amo', { users: 3 }, ['gh:owner/blocker']),
    snap('gh:owner/blocker', 'github', { stars: 1 }),
  ])
  const [project] = buildProjects()
  expect(project!.reach).toEqual({
    label: '1,000',
    source: 'cws',
    bucket: true,
    delta: null,
  })
})

test('a Firefox only extension reports daily users as a number that can move', () => {
  store([snap('amo:solo', 'amo', { users: 1200 })])
  const [project] = buildProjects()
  expect(project!.reach?.label).toBe('1.2k')
  expect(project!.reach?.bucket).toBe(false)
})

test('a package has no reach at all, which is not the same as a reach of zero', () => {
  store([snap('npm:thing', 'npm', { downloadsWeek: 10 })])
  expect(buildProjects()[0]!.reach).toBeNull()
})

test('the rating shown is the best evidenced one, and an unrated store never wins', () => {
  store([
    snap('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', { rating: 4.8, ratings: 12 }, [
      'gh:owner/blocker',
    ]),
    snap('amo:blocker', 'amo', { rating: 5, ratings: 1 }, ['gh:owner/blocker']),
    snap('gh:owner/blocker', 'github', { stars: 0 }),
  ])
  expect(buildProjects()[0]!.rating).toEqual({ score: 4.8, count: 12, source: 'cws' })
})

test('an add-on nobody rated reports no score rather than an average of zero', () => {
  store([snap('amo:fresh', 'amo', { users: 2, rating: null, ratings: 0 })])
  expect(buildProjects()[0]!.rating).toBeNull()
})
