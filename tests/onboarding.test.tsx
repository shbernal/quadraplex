import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Suggestion } from '../src/commands/init.ts'
import type { Ecosystem } from '../src/core/types.ts'
import { selectGlyphs, width } from '../src/tui/cells.ts'
import { Root } from '../src/tui/onboard.tsx'
import { onboardingFrame, ROW_ORDER, type OnboardingView } from '../src/tui/onboarding.ts'
import { mountTerminal } from './terminal.tsx'

let dir: string
let probes: Record<string, string>[]
let refreshed: (Ecosystem | null)[]

const SUGGESTED: Suggestion[] = [
  { ecosystem: 'npm', value: 'me', source: 'gh', status: 'found', count: 3 },
  { ecosystem: 'pypi', value: 'me', source: 'gh', status: 'none', count: 0 },
  { ecosystem: 'github', value: 'me', source: 'gh', status: 'found', count: 9 },
  { ecosystem: 'amo', value: 'me', source: 'gh', status: 'unchecked', reason: 'offline' },
  { ecosystem: 'cws', value: null, source: null, status: 'none' },
]

async function onProbe(flags: Record<string, string>): Promise<Suggestion[]> {
  probes.push(flags)
  if (flags.only === 'amo') {
    return [
      { ecosystem: 'amo', value: '42', source: 'typed', status: 'found', count: 2, label: 'Me' },
    ]
  }
  return SUGGESTED.map((s) => {
    const typed = flags[s.ecosystem]
    return typed ? Object.assign({}, s, { value: typed, source: 'typed' as const }) : s
  })
}

async function onRefresh(only: Ecosystem | null) {
  refreshed.push(only)
  return null
}

function mount(start: 'dashboard' | 'accounts', cols = 90, rows = 24) {
  return mountTerminal(<Root start={start} onProbe={onProbe} onRefresh={onRefresh} />, cols, rows)
}

const config = () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  probes = []
  refreshed = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
})

test('hits are checked, misses left empty, and quitting writes nothing', async () => {
  const app = mount('accounts')
  await app.press('')
  const frame = app.frame()
  expect(frame).toMatch(/\[x\].*GitHub\s+me\s+gh · 9 repos/)
  expect(frame).toMatch(/\[ \].*PyPI\s+-\s+nothing found for me/)
  expect(frame).toMatch(/\[ \].*Firefox add-ons\s+me\s+couldn't check: offline/)
  expect(frame).toMatch(/\[ \].*Chrome Web Store\s+-\s+║/)
  await app.press('\u001b')
  expect(app.exited()).toBe(true)
  expect(existsSync(join(dir, 'config.json'))).toBe(false)
})

test('an edited row is probed alone, and save writes the checked rows then refreshes them', async () => {
  const app = mount('accounts')
  await app.press('')
  // Down to AMO and replace its value, which moves on to the next row, then uncheck npm and save.
  await app.press(`${'j'.repeat(ROW_ORDER.indexOf('amo'))}\r\u007f\u007fme-on-amo\r`)
  expect(probes.at(-1)).toEqual({ only: 'amo', amo: 'me-on-amo' })
  expect(app.frame()).toMatch(/\[x\].*Firefox add-ons\s+42\s+Me · 2 add-ons/)
  expect(app.frame()).toMatch(/▌.*Chrome Web Store/)
  await app.press(`${'k'.repeat(ROW_ORDER.indexOf('cws') - ROW_ORDER.indexOf('npm'))} `)
  expect(app.frame()).toMatch(/\[ \].*npm\s+me/)
  // From npm down past the last row to the save line.
  await app.press(`${'j'.repeat(ROW_ORDER.length - ROW_ORDER.indexOf('npm'))}\r`)
  expect(config()).toEqual({ accounts: { github: 'me', amo: '42' } })
  await Bun.sleep(50)
  expect(refreshed).toEqual(['github', 'amo'])
  expect(app.frame()).toContain('nothing here')
  app.unmount()
})

test('the first refresh runs every source at once, each row done as its own finishes', async () => {
  const release: Partial<Record<Ecosystem, () => void>> = {}
  const held = (only: Ecosystem | null) =>
    new Promise<null>((resolve) => (release[only!] = () => resolve(null)))
  const app = mountTerminal(<Root start="accounts" onProbe={onProbe} onRefresh={held} />, 90, 24)
  await app.press('')
  await app.press(`${'j'.repeat(ROW_ORDER.length)}\r`)
  expect(Object.keys(release).toSorted()).toEqual(['github', 'npm'])
  release.npm!()
  await Bun.sleep(50)
  expect(app.frame()).toMatch(/GitHub\s+refreshing/)
  expect(app.frame()).toMatch(/npm\s+done/)
  release.github!()
  await Bun.sleep(50)
  expect(app.frame()).toContain('nothing here')
  app.unmount()
})

test('a reconfigure starts from the saved accounts and escape returns to the dashboard', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ accounts: { pypi: 'mine' } }))
  const app = mount('dashboard')
  await app.press('a')
  expect(probes[0]).toEqual({ pypi: 'mine' })
  expect(app.frame()).toMatch(/\[x\].*PyPI\s+mine\s+.*nothing found/)
  expect(app.frame()).toContain('Unchecked rows are removed')
  await app.press('\u001b')
  expect(app.exited()).toBe(false)
  expect(app.frame()).toContain('REGISTRIES')
  app.unmount()
})

test('saving with nothing checked is refused', async () => {
  const app = mount('accounts')
  await app.press('')
  await app.press(` jjj ${'j'.repeat(ROW_ORDER.length - 3)}\r`)
  expect(app.frame()).toContain('check at least one account')
  expect(existsSync(join(dir, 'config.json'))).toBe(false)
  app.unmount()
})

test('the accounts frame is exactly the terminal at every size and glyph table', () => {
  const accounts = ROW_ORDER.map((ecosystem) => ({
    ecosystem,
    checked: true,
    value: 'a-rather-long-account-name-that-runs-on',
    origin: 'gh' as const,
    status: 'unchecked' as const,
    reason: 'a long reason that has to give way to the border',
  }))
  const base: OnboardingView = {
    rows: accounts,
    cursor: 0,
    editing: null,
    progress: null,
    notice: 'something went wrong',
    tick: 3,
    reconfigure: false,
  }
  const views: OnboardingView[] = [
    base,
    { ...base, editing: 'typed', cursor: 2 },
    { ...base, progress: ROW_ORDER.map((ecosystem) => ({ ecosystem, state: 'running' })) },
  ]
  for (const ascii of [false, true]) {
    selectGlyphs(ascii)
    for (const [cols, rows] of [
      [80, 24],
      [120, 40],
      [50, 10],
    ] as const) {
      for (const view of views) {
        const lines = onboardingFrame(view, cols, rows)
        expect(lines).toHaveLength(rows)
        for (const line of lines) expect(width(line)).toBe(cols)
      }
    }
  }
  selectGlyphs(false)
})
