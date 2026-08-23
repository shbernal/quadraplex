import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SCHEMA_VERSION } from '../src/core/types.ts'

const skill = readFileSync(new URL('../skills/quadraplex/SKILL.md', import.meta.url), 'utf8')

/**
 * The skill teaches a specific payload shape. If the CLI's schema moves and this file does
 * not, agents are being taught something untrue, so the drift is a build failure.
 */
test('the skill pins the schema version the CLI actually emits', () => {
  const match = /`schemaVersion`, which is `(\d+)`/.exec(skill)
  expect(match).not.toBeNull()
  expect(Number(match![1])).toBe(SCHEMA_VERSION)
})

test('the skill carries the frontmatter that skills add expects', () => {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? ''
  expect(frontmatter).toMatch(/^name: quadraplex$/m)
  expect(frontmatter).toMatch(/^description: \S/m)
})

test('the skill states the guardrail that unscoped fresh is refused', () => {
  expect(skill).toMatch(/--fresh` requires a target/)
})
