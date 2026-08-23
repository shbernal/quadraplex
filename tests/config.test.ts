import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, loadConfig } from '../src/core/config.ts'
import { paths } from '../src/core/paths.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
})

function load(config: unknown) {
  writeFileSync(paths.config, JSON.stringify(config))
  return loadConfig()
}

test('an absent file yields the defaults', () => {
  expect(loadConfig()).toEqual(DEFAULT_CONFIG)
})

test('a valid config loads with its values over the defaults', () => {
  const config = load({
    accounts: { npm: 'you' },
    include: ['pypi:pkg', 'cws:abcdefghijklmnopabcdefghijklmnop'],
    exclude: ['gh:you/old'],
    includeArchived: true,
    links: { 'pypi:pkg': ['gh:you/pkg'] },
    ttl: { github: '2h' },
    deltaWindow: { npm: '7d' },
  })
  expect(config.accounts).toEqual({ ...DEFAULT_CONFIG.accounts, npm: 'you' })
  expect(config.includeArchived).toBe(true)
  expect(config.ttl.github).toBe('2h')
  expect(config.links).toEqual({ 'pypi:pkg': ['gh:you/pkg'] })
})

test.each([
  [{ include: 'pypi:charcheck' }, '"include"'],
  [{ include: ['charcheck'] }, '"include"'],
  [{ include: ['pypi:'] }, '"include"'],
  [{ exclude: 'npm:foo' }, '"exclude"'],
  [{ accounts: 'shbernal' }, '"accounts"'],
  [{ accounts: { gh: 'shbernal' } }, '"accounts.gh"'],
  [{ includeArchived: 'true' }, '"includeArchived"'],
  [{ includeForks: 'false' }, '"includeForks"'],
  [{ links: { 'cws:x': 'gh:a/b' } }, '"links.cws:x"'],
  [{ links: { nope: ['gh:a/b'] } }, '"links.nope"'],
  [{ ttl: { npm: 'soon' } }, '"ttl.npm"'],
  [{ ttl: { gh: '1h' } }, '"ttl.gh"'],
  [{ deltaWindow: { curves: '1d' } }, '"deltaWindow.curves"'],
  [{ inclde: [] }, '"inclde"'],
])('%j is rejected naming %s', (config, key) => {
  expect(() => load(config)).toThrow(key)
})
