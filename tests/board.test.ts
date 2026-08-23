import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendSnapshots, writeSkills } from '../src/core/store.ts'
import type { Ecosystem, MetricValue, Snapshot } from '../src/core/types.ts'
import { buildBoard, DEFAULT_VIEW, viewBoard } from '../src/tui/board.ts'
import { G, selectGlyphs, wantsAscii, width, type Line } from '../src/tui/cells.ts'
import { frame, type Ui } from '../src/tui/frame.ts'

let dir: string
const DAY = 86_400_000

function snap(
  id: string,
  ecosystem: Ecosystem,
  metrics: Record<string, MetricValue>,
  links: string[] = [],
  fetchedAt = new Date().toISOString(),
): Snapshot {
  return {
    id,
    ecosystem,
    name: id.slice(id.indexOf(':') + 1),
    url: `https://example.test/${id}`,
    discovered: 'auto',
    metrics,
    links,
    fetchedAt,
  }
}

function configure(accounts: Partial<Record<Ecosystem, string>>): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ accounts }))
}

const old = new Date(Date.now() - 2 * DAY).toISOString()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  configure({ npm: 'me', pypi: 'me', github: 'me', amo: '1', cws: 'me' })
  appendSnapshots([
    // Every repo is past its TTL, so the GitHub pane is wholly stale.
    snap('gh:me/tool', 'github', { stars: 4, forks: 1, openIssues: 2, openPRs: 1 }, [], old),
    snap('gh:me/quiet', 'github', { stars: 0, openIssues: null, openPRs: null }, [], old),
    snap('gh:me/blocker', 'github', { stars: 9, openIssues: 0, openPRs: 0 }, [], old),
    snap('npm:@me/tool', 'npm', { downloadsWeek: 120, version: '1.0.0' }, ['gh:me/tool']),
    snap('pypi:tool', 'pypi', { downloadsWeek: 30, version: '1.0.0' }, ['gh:me/tool']),
    snap('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', { users: '1,000', version: '2.0' }, [
      'gh:me/blocker',
    ]),
    snap('amo:blocker', 'amo', { users: 14, version: '2.1', rating: 4.5, ratings: 3 }, [
      'gh:me/blocker',
    ]),
  ])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
})

const ui = (overlay: Ui['overlay'] = null, pane = 0): Ui => ({
  pane,
  cursors: {},
  scrolls: {},
  overlay,
  busy: null,
  notice: null,
  focus: 0,
  offset: 0,
  view: DEFAULT_VIEW,
  typing: false,
})

const text = (line: Line) => line.map((s) => s.t).join('')

test('a frame is exactly the terminal, at every size, overlay and glyph table', () => {
  for (const ascii of [false, true]) {
    selectGlyphs(ascii)
    framesFit()
  }
  selectGlyphs(false)
})

test('plain glyphs are chosen on request and wherever a font is unlikely', () => {
  expect(wantsAscii({})).toBe(false)
  expect(wantsAscii({ QUADRAPLEX_ASCII: '1' })).toBe(true)
  expect(wantsAscii({ TERM: 'dumb' })).toBe(true)
  expect(wantsAscii({ NO_COLOR: '1' })).toBe(true)
})

function framesFit() {
  for (const accounts of [
    { npm: 'me', github: 'me', amo: '1' },
    { github: 'me', cws: 'me' },
    { github: 'me', clawhub: 'me' },
    { pypi: 'me' },
    {},
  ]) {
    configure(accounts)
    framesFitBoard(buildBoard())
  }
  configure({ npm: 'me', pypi: 'me', github: 'me', amo: '1', cws: 'me' })
}

function framesFitBoard(board: ReturnType<typeof buildBoard>) {
  for (const [cols, rows] of [
    [80, 24],
    [120, 40],
    [160, 50],
    [60, 12],
  ] as const) {
    for (const overlay of [null, 'legend', 'detail'] as const) {
      for (const pane of board.panes.length ? board.panes.keys() : [0]) {
        const lines = frame(board, ui(overlay, pane), cols, rows)
        expect(lines).toHaveLength(rows)
        for (const line of lines) expect(width(line)).toBe(cols)
      }
    }
  }
}

test('a target with no baseline reads "new", never a zero delta', () => {
  const lines = frame(buildBoard(), ui(null, 1), 120, 40).map(text)
  const row = lines.find((l) => l.includes('tool') && l.includes('120'))
  expect(row).toContain('new')
})

test('a wholly stale pane says so once in its border, not on every row', () => {
  const board = buildBoard()
  const github = board.panes.find((p) => p.id === 'github')!
  expect(github.stale).toBe(3)
  expect(github.rows.every((r) => r.status !== 'stale')).toBe(true)
})

test('an unknown pull request count sorts after every known one', () => {
  const github = buildBoard().panes.find((p) => p.id === 'github')!
  expect(github.rows.map((r) => r.name)).toEqual(['tool', 'blocker', 'quiet'])
})

test('a filter narrows every pane, and the project stays linked across them', () => {
  const board = viewBoard(buildBoard(), { ...DEFAULT_VIEW, query: 'tool' })
  const keys = board.panes.map((p) => p.rows.map((r) => r.key))
  expect(keys[0]).toHaveLength(1)
  expect(keys[1]).toEqual([keys[0]![0]!, keys[0]![0]!])
  expect(keys[2]).toEqual([])
})

test('a pane sort holds when a metric behind it is missing, and leaves other panes alone', () => {
  const base = buildBoard()
  const named = viewBoard(base, { query: '', sorts: { github: 'name' } })
  expect(named.panes[0]!.rows.map((r) => r.name)).toEqual(['blocker', 'quiet', 'tool'])
  expect(named.panes[1]!.rows).toEqual(base.panes[1]!.rows)
  for (const sort of ['drift', 'age'] as const) {
    const rows = viewBoard(base, {
      query: '',
      sorts: { github: sort, registries: sort, extensions: sort },
    }).panes.map((p) => p.rows)
    expect(rows.map((r) => r.length)).toEqual(base.panes.map((p) => p.rows.length))
  }
})

test("Google's bucket is shown verbatim and marked, beside Firefox's countable users", () => {
  const extensions = frame(buildBoard(), ui(null, 2), 120, 40).map(text)
  const row = extensions.find((l) => l.includes('blocker') && l.includes('≈1,000'))
  expect(row).toContain('14')
})

test('only the panes the config names are drawn, an empty one included', () => {
  configure({ github: 'me', cws: 'me' })
  const board = buildBoard()
  expect(board.panes.map((p) => p.id)).toEqual(['github', 'extensions'])
  // amo has snapshots but no account, so its add-on leaves the pane and its lamp goes out.
  expect(board.panes[1]!.rows.flatMap((r) => r.targets.map((t) => t.ecosystem))).toEqual(['cws'])
  expect(board.sources.map((s) => s.ecosystem)).toEqual(['github', 'cws'])
  // Nor does Firefox keep a column or a gauge in it.
  const extensions = board.panes[1]!
  const heads = extensions.columns.flatMap((c) => c.head.map((s) => s.t))
  expect(heads).toContain(G.chrome)
  expect(heads).not.toContain(G.firefox)
  expect(extensions.summary.map((s) => s.t).join('')).not.toContain(G.firefox)

  rmSync(dir, { recursive: true })
  mkdirSync(dir)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ include: ['pypi:other'] }))
  const empty = buildBoard()
  expect(empty.panes.map((p) => p.id)).toEqual(['registries'])
  expect(frame(empty, ui(), 80, 24).map(text).join('\n')).toContain('nothing here')
})

const heads = (pane: { columns: { head: Line }[] }) =>
  pane.columns.flatMap((c) => c.head.map((s) => s.t))

test('a second skill store gets a pane of its own, one row per skill across both', () => {
  appendSnapshots([
    snap('gh:me/kit', 'github', { stars: 1, skills: 2, skillInstalls: 5 }),
    snap('clawhub:kit-lookup', 'clawhub', { installs: 3, version: '0.2.0' }),
    snap('clawhub:solo', 'clawhub', { installs: 1 }),
  ])
  writeSkills({
    id: 'gh:me/kit',
    fetchedAt: new Date().toISOString(),
    skills: [
      { name: 'Kit Lookup', description: 'd', path: 'SKILL.md', sha: 'a', installs: 5 },
      { name: 'quiet', description: 'd', path: 'q/SKILL.md', sha: 'b', installs: null },
    ],
  })
  configure({ github: 'me' })
  const single = buildBoard()
  expect(single.panes.map((p) => p.id)).toEqual(['github'])
  expect(heads(single.panes[0]!)).toContain(G.skill)

  configure({ github: 'me', clawhub: 'me' })
  const board = buildBoard()
  const [github, skills] = board.panes
  expect(skills!.id).toBe('skills')
  expect(heads(github!)).not.toContain(G.skill)
  // The ClawHub skill joins the repo publishing the same slug, unknown sorts last.
  expect(skills!.rows.map((r) => r.name)).toEqual(['kit-lookup', 'solo', 'quiet'])
  const kit = github!.rows.find((r) => r.name === 'kit')!
  expect(skills!.rows[0]!.key).toBe(kit.key)
  expect(skills!.rows[1]!.key).not.toBe(kit.key)
  expect(skills!.summary.map((s) => s.t).join('')).toContain('Σ 9')
  const lines = frame(board, ui(null, 1), 120, 40).map(text)
  expect(lines.find((l) => l.includes('kit-lookup'))).toMatch(/5\s+3\s+new\s+8\s+0\.2\.0/)
  expect(lines.find((l) => l.includes('quiet'))).toContain('?')
})
