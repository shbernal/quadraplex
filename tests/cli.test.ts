import { expect, test } from 'bun:test'
import { parseArgv, UsageError } from '../src/core/args.ts'
import { rejectUnscopedFresh } from '../src/commands/guards.ts'
import { parseDuration } from '../src/core/duration.ts'
import { formatDelta } from '../src/core/format.ts'
import { parseTargetId, targetId } from '../src/core/types.ts'

test('argv splits into a command, positionals and flags', () => {
  const parsed = parseArgv(['npm', 'gitpulse', '--json', '--fresh'])
  expect(parsed.command).toBe('npm')
  expect(parsed.positionals).toEqual(['gitpulse'])
  expect(parsed.flags).toEqual({ json: true, fresh: true })
})

test('--only takes a value, attached or separate', () => {
  expect(parseArgv(['refresh', '--only', 'npm']).flags.only).toBe('npm')
  expect(parseArgv(['refresh', '--only=pypi']).flags.only).toBe('pypi')
  expect(() => parseArgv(['refresh', '--only'])).toThrow(UsageError)
  expect(parseArgv(['refresh', '--only=a=b']).flags.only).toBe('a=b')
})

test('unscoped --fresh is refused and the message names refresh', () => {
  expect(() => rejectUnscopedFresh('status', { fresh: true })).toThrow(/qplex refresh/)
  expect(() => rejectUnscopedFresh('list', { fresh: true })).toThrow(UsageError)
  expect(() => rejectUnscopedFresh('status', {})).not.toThrow()
})

test('durations parse by unit and reject anything else', () => {
  expect(parseDuration('24h')).toBe(86_400_000)
  expect(parseDuration('30d')).toBe(2_592_000_000)
  expect(() => parseDuration('soon')).toThrow()
})

test('an unknown delta renders as new and a zero delta renders as zero', () => {
  expect(formatDelta(null)).toBe('new')
  expect(formatDelta(undefined)).toBe('new')
  expect(formatDelta(0)).toBe('0')
  expect(formatDelta(1200)).toBe('+1.2k')
  expect(formatDelta(-3)).toBe('-3')
})

test('target ids round trip, with github abbreviated to gh', () => {
  expect(targetId('github', 'shbernal/gitpulse')).toBe('gh:shbernal/gitpulse')
  expect(parseTargetId('gh:shbernal/gitpulse')).toEqual({
    ecosystem: 'github',
    name: 'shbernal/gitpulse',
  })
  expect(parseTargetId('npm:@shbernal/gitpulse')).toEqual({
    ecosystem: 'npm',
    name: '@shbernal/gitpulse',
  })
  expect(parseTargetId('nope')).toBeNull()
})
