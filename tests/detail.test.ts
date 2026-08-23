import { expect, test } from 'bun:test'
import { metricLabel, metricText } from '../src/core/format.ts'
import type { Ecosystem, Target } from '../src/core/types.ts'
import type { IssueDetail } from '../src/sources/github.ts'
import { delta } from '../src/tui/board.ts'
import { width } from '../src/tui/cells.ts'
import { detailBox, itemBox, itemScrollMax, sparkline, type Inspect } from '../src/tui/detail.ts'
import { focusables, type Project } from '../src/tui/model.ts'
import { C } from '../src/tui/theme.ts'

function target(id: string, ecosystem: Ecosystem, metrics: number): Target {
  return {
    id,
    ecosystem,
    name: id.slice(id.indexOf(':') + 1),
    url: `https://example.test/${id}`,
    discovered: 'auto',
    metrics: Object.fromEntries(Array.from({ length: metrics }, (_, i) => [`metric${i}`, i])),
    links: [],
    fetchedAt: new Date().toISOString(),
    deltas: null,
    stale: false,
  }
}

function project(targets: Target[]): Project {
  return {
    key: targets.map((t) => t.id).join('+'),
    name: 'demo',
    targets,
    series: Array.from({ length: 120 }, (_, i) => ({ date: `d${i}`, downloads: i })),
    rating: null,
    drift: { version: null, versions: null, unreleased: null },
    skills: [],
  }
}

const issue = (number: number, body = ''): IssueDetail => ({
  number,
  title: `issue ${number}`,
  url: `https://example.test/issues/${number}`,
  author: 'someone',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  comments: 0,
  labels: [],
  kind: 'issue',
  draft: false,
  body,
})

function inspected(p: Project, items: IssueDetail[] = []): Inspect {
  return {
    project: p,
    items,
    stargazers: null,
    waiting: true,
    releases: [],
    skills: [],
    focus: focusables(p, items),
  }
}

const text = (lines: ReturnType<typeof detailBox>) => lines.map((l) => l.map((s) => s.t).join(''))

test('a detail overlay fits the terminal however many stores a project spans', () => {
  const wide = inspected(
    project([
      target('amo:demo', 'amo', 6),
      target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', 7),
      target('gh:owner/demo', 'github', 9),
      target('npm:demo', 'npm', 5),
    ]),
    [issue(1), issue(2)],
  )
  for (const rows of [10, 24, 40]) {
    for (const cursor of [0, 3, 5]) {
      const lines = detailBox(wide, cursor, 100, rows)
      expect(lines.length).toBeLessThanOrEqual(rows - 2)
      expect(new Set(lines.map(width)).size).toBe(1)
    }
  }
})

test('the window follows the cursor, so the focused line is always on screen', () => {
  const many = inspected(project([target('gh:owner/demo', 'github', 30)]), [issue(7)])
  const lines = text(detailBox(many, 1, 100, 16))
  expect(lines.some((l) => l.includes('issue 7') && l.includes('▌'))).toBe(true)
})

test('every line of a detail overlay fits the width it is given', () => {
  const long = target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', 4)
  long.url = `https://chromewebstore.google.com/detail/${'x'.repeat(120)}/abcdefghijklmnop`
  for (const line of detailBox(inspected(project([long])), 0, 60, 24)) {
    expect(width(line)).toBe(56)
  }
})

test('an issue body scrolls no further than its last line', () => {
  const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
  const max = itemScrollMax(issue(1, body), 80, 24)
  expect(max).toBe(50 - (24 - 4 - 4))
  const last = text(itemBox(issue(1, body), max + 10, 80, 24))
  expect(last.some((l) => l.includes('line 49'))).toBe(true)
  expect(itemBox(issue(1, body), 0, 80, 24)).toHaveLength(24 - 4 + 2)
})

test('the detail cursor walks targets before open items, so "o" always has an answer', () => {
  const both = project([target('gh:owner/demo', 'github', 2), target('npm:demo', 'npm', 2)])
  const focus = focusables(both, [issue(3)])
  expect(focus.map((f) => f.kind)).toEqual(['target', 'target', 'item'])
  expect(focus[0]!.url).toBe('https://example.test/gh:owner/demo')
})

test('a sparkline scales to its own maximum and fits the width it is given', () => {
  expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8)).toBe('▁▂▃▄▅▆▇█')
  expect(sparkline([1, 1, 1], 3)).toBe('███')
  expect(sparkline([0, 0, 0], 3)).toBe('▁▁▁')
  expect(
    sparkline(
      Array.from({ length: 90 }, (_, i) => i),
      10,
    ),
  ).toHaveLength(10)
})

test('an empty series renders nothing rather than a misleading flat line', () => {
  expect(sparkline([], 10)).toBe('')
  expect(sparkline([1, 2, 3], 0)).toBe('')
})

test('a delta is coloured by its sign, and an unknown one is not a fall', () => {
  expect(delta(12)[0]).toMatchObject({ t: '▲12', c: C.up })
  expect(delta(-12)[0]).toMatchObject({ t: '▼12', c: C.down })
  expect(delta(0)[0]!.c).toBe(C.muted)
  expect(delta(null)[0]).toMatchObject({ t: 'new', c: C.muted })
})

test('a metric value is printed as published, except a timestamp nobody can read', () => {
  expect(metricText('1,000')).toBe('1,000')
  expect(metricText(null)).toBe('-')
  expect(metricText('master')).toBe('master')
  expect(metricText('2019-06-22')).toBe('Jun 22, 2019')
  expect(metricText('2019-06-22T07:20:29Z')).toBe('Jun 22, 2019')
  expect(metricLabel('downloadsWeek')).toBe('downloads, week')
  expect(metricLabel('stars')).toBe('stars')
})

test('an npm target with downloads on several versions shows its release tracks', () => {
  const npm = {
    ...target('npm:demo', 'npm', 2),
    versions: { '0.2.1': 690, '0.2.2-next.7': 85, '0.2.2-next.6': 110 },
  }
  const lines = text(detailBox(inspected(project([npm])), 0, 100, 60))
  const at = lines.findIndex((l) => l.includes('release tracks'))
  expect(at).toBeGreaterThan(0)
  expect(lines[at + 1]).toMatch(/stable\s+690\s+78%\s+0\.2\.1 690/)
  expect(lines[at + 2]).toMatch(/next\s+195\s+22%\s+0\.2\.2-next\.6 110, 1 other 85/)

  const single = { ...npm, versions: { '0.2.1': 690 } }
  const alone = text(detailBox(inspected(project([single])), 0, 100, 60))
  expect(alone.some((l) => l.includes('release tracks'))).toBe(false)
})
