import { expect, test } from 'bun:test'
import { computeDrift } from '../src/core/drift.ts'
import type { Ecosystem, MetricValue, Target } from '../src/core/types.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-30T12:00:00.000Z')

function target(id: string, ecosystem: Ecosystem, metrics: Record<string, MetricValue>): Target {
  return {
    id,
    ecosystem,
    name: id.slice(id.indexOf(':') + 1),
    url: `https://example.test/${id}`,
    discovered: 'auto',
    metrics,
    links: [],
    fetchedAt: new Date(NOW).toISOString(),
    deltas: null,
    stale: false,
  }
}

const at = (offset: number) => new Date(NOW + offset).toISOString()

test('two stores on different versions is drift, and both versions are named', () => {
  const drift = computeDrift([
    target('amo:blocker', 'amo', { version: '1.4.1' }),
    target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', { version: '1.4.0' }),
  ])
  expect(drift.version).toBeNull()
  expect(drift.versions).toEqual([
    { ecosystem: 'amo', version: '1.4.1' },
    { ecosystem: 'cws', version: '1.4.0' },
  ])
})

test('two stores agreeing report the one version and no drift', () => {
  const drift = computeDrift([
    target('amo:blocker', 'amo', { version: '0.2.0' }),
    target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', { version: '0.2.0' }),
  ])
  expect(drift.version).toBe('0.2.0')
  expect(drift.versions).toBeNull()
})

test('a monorepo publishing packages on their own cadence is not drift', () => {
  const drift = computeDrift([
    target('npm:@scope/cli', 'npm', { version: '0.0.4' }),
    target('npm:@scope/core', 'npm', { version: '0.2.0' }),
    target('gh:owner/repo', 'github', { stars: 1 }),
  ])
  expect(drift.versions).toBeNull()
  expect(drift.version).toBeNull()
})

test('a monorepo that disagrees with itself still cannot mask a second store', () => {
  const drift = computeDrift([
    target('npm:@scope/cli', 'npm', { version: '0.0.4' }),
    target('npm:@scope/core', 'npm', { version: '0.2.0' }),
    target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', { version: '9.9.9' }),
  ])
  expect(drift.version).toBe('9.9.9')
  expect(drift.versions).toBeNull()
})

test('a push more than a day after the newest release is unreleased work', () => {
  const drift = computeDrift([
    target('npm:thing', 'npm', { version: '1.0.0', lastPublish: at(-20 * DAY) }),
    target('gh:owner/thing', 'github', { lastPush: at(-2 * DAY) }),
  ])
  expect(drift.unreleased).toEqual({ pushedAt: at(-2 * DAY), publishedAt: at(-20 * DAY) })
})

test('the commit that follows a release within the day is not unreleased work', () => {
  const drift = computeDrift([
    target('npm:thing', 'npm', { version: '1.0.0', lastPublish: at(-20 * DAY) }),
    target('gh:owner/thing', 'github', { lastPush: at(-20 * DAY + 900_000) }),
  ])
  expect(drift.unreleased).toBeNull()
})

test('a counted release tag outranks the dates, either way', () => {
  const npm = target('npm:thing', 'npm', { version: '1.0.0', lastPublish: at(-20 * DAY) })
  const repo = (unreleasedCommits: number) =>
    target('gh:owner/thing', 'github', { lastPush: at(-2 * DAY), unreleasedCommits })
  // A push to another branch moves pushed_at without putting anything past the tag.
  expect(computeDrift([npm, repo(0)]).unreleased).toBeNull()
  expect(computeDrift([npm, repo(3)]).unreleased).not.toBeNull()
})

test('a repo with nothing published anywhere cannot be behind a release', () => {
  expect(
    computeDrift([target('gh:owner/thing', 'github', { lastPush: at(-DAY) })]).unreleased,
  ).toBeNull()
})

test('a release known only to the day counts from the end of that day', () => {
  const cws = target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', { lastPublish: '2026-08-05' })
  const pushed = (lastPush: string) =>
    computeDrift([cws, target('gh:o/r', 'github', { lastPush })]).unreleased
  expect(pushed('2026-08-06T01:00:00Z')).toBeNull()
  expect(pushed('2026-08-07T01:00:00Z')).toEqual({
    pushedAt: '2026-08-07T01:00:00Z',
    publishedAt: '2026-08-05',
  })
})

test('the newest release is picked across day-only and full timestamps', () => {
  const drift = computeDrift([
    target('npm:x', 'npm', { lastPublish: '2026-08-04T12:00:00Z' }),
    target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', { lastPublish: '2026-08-05' }),
    target('npm:y', 'npm', { lastPublish: '2026-08-03T23:00:00Z' }),
    target('gh:o/r', 'github', { lastPush: '2026-08-08T00:00:00Z' }),
  ])
  expect(drift.unreleased?.publishedAt).toBe('2026-08-05')
})

test('a GitHub release behind the image it ships is drift like any other store', () => {
  const drift = computeDrift([
    target('gh:owner/tool', 'github', { version: '1.9.0' }),
    target('ghcr:owner/tool', 'ghcr', { version: '2.0.0' }),
  ])
  expect(drift.versions).toEqual([
    { ecosystem: 'github', version: '1.9.0' },
    { ecosystem: 'ghcr', version: '2.0.0' },
  ])
})
