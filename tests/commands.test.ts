import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, run } from '../src/cli.ts'
import { UsageError } from '../src/core/args.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { paths } from '../src/core/paths.ts'
import { ECOSYSTEMS, type MetricValue, type Snapshot } from '../src/core/types.ts'
import { statusPayload, statusTable } from '../src/commands/status.ts'
import { resetTokenCache } from '../src/sources/github.ts'

let dir: string
let out: string[]
let err: string[]
const realLog = console.log
const realError = console.error
const realFetch = globalThis.fetch
const realTty = process.stdout.isTTY

const HOUR = 3_600_000

function snap(id: string, ago: number, metrics: Record<string, MetricValue>): Snapshot {
  const ecosystem = id.startsWith('gh:') ? 'github' : id.startsWith('cws:') ? 'cws' : 'npm'
  return {
    id,
    ecosystem,
    name: id.slice(id.indexOf(':') + 1),
    url: `https://example.test/${id}`,
    discovered: 'auto',
    metrics,
    links: [],
    fetchedAt: new Date(Date.now() - ago).toISOString(),
  }
}

function seed(...snapshots: Snapshot[]): void {
  writeFileSync(paths.snapshots, snapshots.map((s) => `${JSON.stringify(s)}\n`).join(''))
}

async function exitCode(argv: string[]): Promise<number | undefined> {
  process.exitCode = undefined
  await main(argv)
  const code = process.exitCode as number | undefined
  process.exitCode = undefined
  return code
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  process.env.GITHUB_TOKEN = 'test-token'
  resetHttpCache()
  resetTokenCache()
  out = []
  err = []
  console.log = (...args: unknown[]) => void out.push(args.join(' '))
  console.error = (...args: unknown[]) => void err.push(args.join(' '))
})

afterEach(() => {
  console.log = realLog
  console.error = realError
  globalThis.fetch = realFetch
  process.stdout.isTTY = realTty
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  delete process.env.GITHUB_TOKEN
})

test('status --json carries the schema, every ecosystem and fetchedAt and stale per target', async () => {
  seed(snap('npm:a', HOUR, { downloadsWeek: 5 }), snap('gh:o/r', HOUR, { stars: 2 }))
  expect(await run(['status', '--json'])).toBe(0)
  const payload = JSON.parse(out.join('\n'))
  expect(payload.schemaVersion).toBeNumber()
  expect(Object.keys(payload.discovery).toSorted()).toEqual([...ECOSYSTEMS].toSorted())
  expect(payload.targets).toHaveLength(2)
  for (const target of payload.targets) {
    expect(target.fetchedAt).toBeString()
    expect(target.stale).toBeBoolean()
  }
})

test('one snapshot per target means an unknown delta, not a zero one', async () => {
  seed(snap('npm:a', HOUR, { downloadsWeek: 5 }))
  await run(['status', '--json'])
  const [target] = JSON.parse(out.join('\n')).targets
  expect(target.delta).toBeNull()
  expect(target.changed).toBe(false)
})

test('--fresh on status, list or the bare command is a usage error naming refresh', async () => {
  expect(await run(['--fresh']).catch((error: unknown) => error)).toBeInstanceOf(UsageError)
  expect(await exitCode(['status', '--fresh'])).toBe(2)
  expect(await exitCode(['list', 'npm', '--fresh'])).toBe(2)
  expect(err.join('\n')).toContain('qplex refresh')
})

test('an unknown command and a list without an ecosystem exit 2', async () => {
  expect(await exitCode(['nonsense'])).toBe(2)
  expect(err.join('\n')).toContain('unknown command "nonsense"')
  expect(await run(['list']).catch((error: unknown) => error)).toBeInstanceOf(UsageError)
})

test('list gh resolves to the github targets', async () => {
  seed(snap('npm:a', HOUR, { downloadsWeek: 5 }), snap('gh:o/r', HOUR, { stars: 2 }))
  await run(['list', 'gh', '--json'])
  const payload = JSON.parse(out.join('\n'))
  expect(payload.ecosystem).toBe('github')
  expect(payload.targets.map((t: { id: string }) => t.id)).toEqual(['gh:o/r'])
})

test('completion names come from the store for one ecosystem, gh included', async () => {
  seed(snap('npm:b', HOUR, {}), snap('npm:a', HOUR, {}), snap('gh:o/r', HOUR, {}))
  await run(['__complete', 'npm'])
  await run(['__complete', 'gh'])
  await run(['__complete', 'nonsense'])
  expect(out).toEqual(['a', 'b', 'o/r'])
})

test('completions prints a bash script and refuses other shells', async () => {
  await run(['completions', 'bash'])
  expect(out.join('\n')).toContain('complete -F _qplex qplex quadraplex')
  expect(await exitCode(['completions', 'zsh'])).toBe(2)
})

test('a piped bare invocation prints the status table instead of opening the dashboard', async () => {
  process.stdout.isTTY = false
  seed(snap('npm:a', HOUR, { downloadsWeek: 5 }))
  expect(await run([])).toBe(0)
  expect(out.join('\n')).toContain('npm:a')
})

test('an install with no config is pointed to init and nothing else', () => {
  expect(statusPayload().hints).toEqual([
    'No accounts are set up. Run "qplex init" to choose them.',
  ])
})

test('a configured empty store explains every empty section', () => {
  writeFileSync(paths.config, '{"accounts": {"npm": "you"}}')
  const { hints } = statusPayload()
  expect(hints).toHaveLength(4)
  expect(hints.join('\n')).toContain('qplex refresh')
})

test('a text headline gets no delta rather than a permanent "new"', async () => {
  seed(snap('cws:abc', HOUR, { users: '10,000+' }))
  expect(statusTable(statusPayload())).not.toMatch(/cws:abc.*new/)
  await run(['list', 'cws', '--json'])
  expect(JSON.parse(out.join('\n')).targets[0].summary).toBe('users 10,000+')
})

test('a runtime error prints its cause, and the stack only when asked', async () => {
  writeFileSync(paths.config, '{ nope')
  expect(await exitCode(['status'])).toBe(1)
  expect(err[0]).toContain('is not valid JSON')
  expect(err[1]).toStartWith('  caused by: ')
  expect(err).toHaveLength(2)

  err = []
  process.env.QUADRAPLEX_DEBUG = '1'
  await exitCode(['status'])
  delete process.env.QUADRAPLEX_DEBUG
  expect(err.at(-1)).toContain('at ')
})

test('a usage error is one line with no stack', async () => {
  process.env.QUADRAPLEX_DEBUG = '1'
  expect(await exitCode(['list'])).toBe(2)
  delete process.env.QUADRAPLEX_DEBUG
  expect(err).toHaveLength(1)
})
