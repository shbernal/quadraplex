import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendSnapshots } from '../src/core/store.ts'
import { buildProjects, matches } from '../src/tui/model.ts'
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
  const accounts = { npm: 'me', pypi: 'me', github: 'me', amo: '1', cws: 'me' }
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ accounts, ...config }))
  appendSnapshots(snapshots)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
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

test('a filter matches the display name and the target ids behind it', () => {
  store([
    snap('npm:@scope/widget', 'npm', { downloadsWeek: 5 }),
    snap('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', { title: 'Blocker' }),
  ])
  const all = buildProjects()
  const hits = (q: string) => all.filter((p) => matches(p, q))
  expect(hits('widget')).toHaveLength(1)
  // The display name strips the scope, so the id is the only place "scope" survives.
  expect(hits('scope')).toHaveLength(1)
  expect(hits('cws')).toHaveLength(1)
  expect(hits('nothing')).toHaveLength(0)
  expect(hits('  ')).toHaveLength(2)
})

test('a Docker Hub image joins the ghcr.io image of its name, or else the repo of its name', () => {
  store(
    [
      snap('gh:me/alcatraz', 'github', { stars: 1 }),
      snap('ghcr:me/alcatraz', 'ghcr', { downloadsWeek: 3 }, ['gh:me/alcatraz']),
      snap('dockerhub:me/alcatraz', 'dockerhub', { downloadsTotal: 153 }),
      snap('gh:me/sandbox', 'github', { stars: 0 }),
      snap('dockerhub:me/sandbox', 'dockerhub', { downloadsTotal: 2 }),
      snap('dockerhub:me/lonely', 'dockerhub', { downloadsTotal: 0 }),
    ],
    { accounts: { github: 'me', ghcr: 'me', dockerhub: 'me' } },
  )
  const ids = buildProjects().map((p) => p.targets.map((t) => t.id).toSorted())
  expect(ids).toEqual([
    ['dockerhub:me/alcatraz', 'gh:me/alcatraz', 'ghcr:me/alcatraz'],
    ['dockerhub:me/lonely'],
    ['dockerhub:me/sandbox', 'gh:me/sandbox'],
  ])
})

test('a JSR package with no repo joins the npm package of its name', () => {
  store(
    [
      snap('npm:@me/slug', 'npm', { downloadsWeek: 3 }),
      snap('jsr:@me/slug', 'jsr', { downloadsWeek: 1 }),
      snap('jsr:@me/lonely', 'jsr', { downloadsWeek: 0 }),
    ],
    { accounts: { npm: 'me', jsr: 'me' } },
  )
  const ids = buildProjects().map((p) => p.targets.map((t) => t.id).toSorted())
  expect(ids.toSorted((a, b) => a[0]!.localeCompare(b[0]!))).toEqual([
    ['jsr:@me/lonely'],
    ['jsr:@me/slug', 'npm:@me/slug'],
  ])
})

test('an Open VSX extension joins the Marketplace extension of its name, unless config links it', () => {
  store(
    [
      snap('vscode:me.tidy', 'vscode', { installs: 40, title: 'Tidy' }, ['gh:me/tidy']),
      snap('openvsx:ns.tidy', 'openvsx', { downloadsTotal: 9 }),
      snap('gh:me/tidy', 'github', { stars: 1 }),
      snap('openvsx:ns.lonely', 'openvsx', { downloadsTotal: 1, title: 'Lonely' }),
      snap('vscode:me.pinned', 'vscode', { installs: 2 }),
      snap('openvsx:ns.pinned', 'openvsx', { downloadsTotal: 2 }),
    ],
    {
      accounts: { github: 'me', vscode: 'me', openvsx: 'ns' },
      links: { 'openvsx:ns.pinned': [] },
    },
  )
  const ids = buildProjects().map((p) => p.targets.map((t) => t.id).toSorted())
  expect(ids).toEqual([
    ['openvsx:ns.lonely'],
    ['vscode:me.pinned'],
    ['openvsx:ns.pinned'],
    ['gh:me/tidy', 'openvsx:ns.tidy', 'vscode:me.tidy'],
  ])
})
