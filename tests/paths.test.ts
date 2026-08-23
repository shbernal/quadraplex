import { afterEach, beforeEach, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../src/core/paths.ts'

const VARS = ['QUADRAPLEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
const platform = process.platform
let saved: Record<string, string | undefined>

function on(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value })
}

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]))
  for (const v of VARS) delete process.env[v]
})

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  on(platform)
})

test('linux splits config, history and cache across the XDG defaults', () => {
  on('linux')
  expect(paths.config).toBe(join(homedir(), '.config/quadraplex/config.json'))
  expect(paths.snapshots).toBe(join(homedir(), '.local/share/quadraplex/snapshots.jsonl'))
  expect(paths.curve('gh:o/r')).toBe(join(homedir(), '.cache/quadraplex/curves/gh_3ao_2fr.json'))
})

test('elsewhere one XDG variable opts into the split layout', () => {
  on('darwin')
  expect(paths.config).toBe(join(homedir(), '.quadraplex/config.json'))
  expect(paths.cache).toBe(join(homedir(), '.quadraplex/cache.json'))
  process.env.XDG_CONFIG_HOME = '/x/config'
  expect(paths.config).toBe('/x/config/quadraplex/config.json')
  expect(paths.state).toBe(join(homedir(), '.local/share/quadraplex/state.json'))
})

test('QUADRAPLEX_HOME puts everything in one directory', () => {
  on('linux')
  process.env.QUADRAPLEX_HOME = '/q'
  process.env.XDG_DATA_HOME = '/x/data'
  expect([paths.config, paths.snapshots, paths.cache]).toEqual([
    '/q/config.json',
    '/q/snapshots.jsonl',
    '/q/cache.json',
  ])
})
