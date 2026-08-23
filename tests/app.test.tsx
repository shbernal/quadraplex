import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendSnapshots } from '../src/core/store.ts'
import { App } from '../src/tui/app.tsx'
import { mountTerminal } from './terminal.tsx'
import { refreshOutcome, type RefreshOutcome } from '../src/tui/spawn.ts'

let dir: string

function mount(columns: number, rows: number, onRefresh?: () => Promise<RefreshOutcome>) {
  return mountTerminal(<App onRefresh={onRefresh} />, columns, rows)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ accounts: { npm: 'me' } }))
  appendSnapshots([
    {
      id: 'npm:charcheck',
      ecosystem: 'npm',
      name: 'charcheck',
      url: 'https://www.npmjs.com/package/charcheck',
      discovered: 'auto',
      metrics: { downloadsWeek: 12 },
      links: [],
      fetchedAt: new Date().toISOString(),
    },
  ])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
})

test('the dashboard starts and draws the store at several sizes', async () => {
  for (const [cols, rows] of [
    [100, 24],
    [60, 16],
  ] as const) {
    const app = mount(cols, rows)
    await app.press('')
    expect(app.frame()).toContain('charcheck')
    app.unmount()
  }
})

test('a refresh that failed says so in the header until the next one', async () => {
  let outcome: RefreshOutcome = '2 failed'
  const app = mount(100, 24, async () => outcome)
  await app.press('R')
  expect(app.frame()).toContain('refresh: 2 failed')
  outcome = null
  await app.press('R')
  expect(app.frame()).not.toContain('refresh:')
  app.unmount()
})

test('q quits even while a refresh is running', async () => {
  const app = mount(100, 24, () => new Promise(() => {}))
  await app.press('R')
  expect(app.frame()).toContain('refreshing')
  await app.press('q')
  expect(app.exited()).toBe(true)
})

test('the filter is a text field: q is typed, and escape restores the old query', async () => {
  const app = mount(100, 24)
  await app.press('/char\r')
  await app.press('/q')
  expect(app.exited()).toBe(false)
  expect(app.frame()).toContain('charq')
  await app.press('\u001b')
  expect(app.frame()).toMatch(/\/ char\s*\n/)
  app.unmount()
})

test('a refresh report becomes a header line only when something failed or retired', () => {
  const report = { ecosystems: [], ok: 3, failed: [], discoveryFailed: [], retired: [] }
  expect(refreshOutcome(report)).toBeNull()
  expect(
    refreshOutcome({
      ...report,
      failed: [{ id: 'npm:a', error: 'x' }],
      discoveryFailed: [{ ecosystem: 'amo', error: 'y' }],
      retired: [{ id: 'cws:b', reason: 'z' }],
    }),
  ).toBe('1 failed, amo discovery failed, 1 retired')
})
