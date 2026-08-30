import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { createElement } from 'react'
import { metricLabel, metricText } from '../src/core/format.ts'
import { Detail } from '../src/tui/detail.tsx'
import { focusables, homeUrl, type Project } from '../src/tui/model.ts'
import type { Ecosystem, Target } from '../src/core/types.ts'

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
    kind: 'package',
    targets,
    changed: false,
    stale: false,
    series: [],
    downloads: null,
    stars: null,
    reach: null,
    rating: null,
    drift: { version: null, versions: null, unreleased: null },
  }
}

/** Renders one frame and returns its lines, the same trick scripts/render-dashboard uses. */
function frame(node: Parameters<typeof render>[0], columns: number, rows: number): string[] {
  const frames: string[] = []
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    write: (chunk: string) => frames.push(chunk),
  }) as unknown as NodeJS.WriteStream
  const instance = render(node, { stdout, patchConsole: false })
  instance.unmount()
  return (frames.at(-1) ?? '').replace(/\n$/, '').split('\n')
}

test('a detail pane fits the terminal however many stores a project spans', () => {
  const wide = project([
    target('amo:demo', 'amo', 6),
    target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', 7),
    target('gh:owner/demo', 'github', 9),
    target('npm:demo', 'npm', 5),
  ])
  for (const rows of [10, 24, 40]) {
    const lines = frame(
      createElement(Detail, {
        project: wide,
        items: [],
        cursor: 0,
        stargazers: null,
        waiting: false,
        width: 100,
        rows: Math.max(rows - 7, 3),
      }),
      100,
      rows,
    )
    expect(lines.length).toBeLessThanOrEqual(rows)
  }
})

test('every line of a detail pane fits the width it is given', () => {
  const long = target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', 4)
  long.url = `https://chromewebstore.google.com/detail/${'x'.repeat(120)}/abcdefghijklmnop`
  const lines = frame(
    createElement(Detail, {
      project: project([long]),
      items: [],
      cursor: 0,
      stargazers: null,
      waiting: false,
      width: 60,
      rows: 17,
    }),
    60,
    24,
  )
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(60)
})

test('the detail cursor walks targets before open items, so "o" always has an answer', () => {
  const both = project([target('gh:owner/demo', 'github', 2), target('npm:demo', 'npm', 2)])
  const focus = focusables(both, [])
  expect(focus.map((f) => f.kind)).toEqual(['target', 'target'])
  expect(focus[0]!.url).toBe('https://example.test/gh:owner/demo')
})

test('the list opens a project at its repo, not at whichever store sorts first', () => {
  const extension = project([
    target('amo:demo', 'amo', 2),
    target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', 2),
    target('gh:owner/demo', 'github', 2),
  ])
  expect(homeUrl(extension)).toBe('https://example.test/gh:owner/demo')
  expect(homeUrl(project([target('cws:abcdefghijklmnopabcdefghijklmnop', 'cws', 2)]))).toBe(
    'https://example.test/cws:abcdefghijklmnopabcdefghijklmnop',
  )
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
