import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { writeSkills } from '../src/core/store.ts'
import { githubSource, resetTokenCache, type Repo } from '../src/sources/github.ts'
import { frontmatter, resetSkillIndex, skillPaths } from '../src/sources/skills.ts'

let dir: string
let requested: string[]
let index: unknown
const realFetch = globalThis.fetch

const TREE = {
  tree: [
    { path: 'README.md', type: 'blob', sha: 'r' },
    { path: 'skills/ledger/SKILL.md', type: 'blob', sha: 'a1' },
    { path: 'skills/hidden/SKILL.md', type: 'blob', sha: 'h1' },
    { path: 'skills/quiet/SKILL.md', type: 'blob', sha: 'q1' },
  ],
}

const FILES: Record<string, string> = {
  'skills/ledger/SKILL.md': '---\nname: triage-ledger\ndescription: Keeps a ledger.\n---\nbody',
  'skills/hidden/SKILL.md': '---\nname: hidden\ndescription: x\nmetadata:\n  internal: true\n---\n',
  'skills/quiet/SKILL.md': '---\nname: quiet\ndescription: >\n  Nobody\n  installed it.\n---\n',
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    full_name: 'shbernal/thing',
    html_url: 'https://github.com/shbernal/thing',
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 0,
    pushed_at: '2026-08-20T00:00:00.000Z',
    default_branch: 'main',
    archived: false,
    fork: false,
    description: null,
    homepage: null,
    ...overrides,
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const fetchOne = (r: Repo) =>
  githubSource.fetch({ name: r.full_name, discovered: 'auto', hint: r }, DEFAULT_CONFIG)
const count = (part: string) => requested.filter((url) => url.includes(part)).length

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  process.env.GITHUB_TOKEN = 'test-token'
  resetHttpCache()
  resetTokenCache()
  resetSkillIndex()
  requested = []
  index = { skills: [{ id: 'shbernal/thing/triage-ledger', installs: 3 }] }
  globalThis.fetch = (async (input: URL | string) => {
    const url = input.toString()
    requested.push(url)
    if (url.includes('/git/trees/')) return json(TREE)
    if (url.startsWith('https://raw.githubusercontent.com/shbernal/thing/main/')) {
      return new Response(FILES[url.split('/main/')[1]!] ?? '')
    }
    if (url.startsWith('https://skills.sh/')) {
      return index ? json(index) : new Response('down', { status: 404 })
    }
    return json([])
  }) as typeof fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
  delete process.env.GITHUB_TOKEN
  globalThis.fetch = realFetch
  resetTokenCache()
})

test('skill paths follow the skills CLI, minus the skills a repo installs for itself', () => {
  expect(
    skillPaths([
      'SKILL.md',
      'skill/SKILL.md',
      'skills/a/SKILL.md',
      'skills/group/b/SKILL.md',
      'skills/a/nested/SKILL.md',
      'skills/node_modules/x/SKILL.md',
      '.claude/skills/c/SKILL.md',
      'docs/deep/d/SKILL.md',
    ]),
  ).toEqual(['SKILL.md', 'skill/SKILL.md', 'skills/a/SKILL.md', 'skills/group/b/SKILL.md'])
  expect(skillPaths(['docs/deep/d/SKILL.md', 'README.md'])).toEqual(['docs/deep/d/SKILL.md'])
  expect(skillPaths(['.agents/skills/x/SKILL.md', '.claude/skills/y/SKILL.md'])).toEqual([])
})

test('frontmatter reads quoted and folded scalars and the internal flag', () => {
  expect(frontmatter('---\nname: "a b"\ndescription: |\n  one\n  two\n---')).toEqual({
    name: 'a b',
    description: 'one two',
    internal: false,
  })
  expect(frontmatter('---\nname: x\nmetadata:\n  internal: true\n---').internal).toBe(true)
  expect(frontmatter('no frontmatter')).toEqual({ internal: false })
})

test('a repo publishing skills carries their count and the installs skills.sh knows of', async () => {
  const fetched = await fetchOne(repo())
  expect(fetched.skills!.skills.map((s) => [s.name, s.installs])).toEqual([
    ['triage-ledger', 3],
    ['quiet', null],
  ])
  expect(fetched.snapshot.metrics.skills).toBe(2)
  expect(fetched.snapshot.metrics.skillInstalls).toBe(3)
})

test('the tree is reread only after a push, and an unchanged SKILL.md is not downloaded again', async () => {
  writeSkills((await fetchOne(repo())).skills!)
  expect(count('/git/trees/')).toBe(1)
  expect(count('raw.githubusercontent.com')).toBe(3)

  await fetchOne(repo())
  expect(count('/git/trees/')).toBe(1)

  await fetchOne(repo({ pushed_at: new Date(Date.now() + 1000).toISOString() }))
  expect(count('/git/trees/')).toBe(2)
  // The internal skill was never kept, so its unchanged blob is the one read again.
  expect(count('raw.githubusercontent.com')).toBe(4)
  // One index search per account and process, however many repos read it.
  expect(count('skills.sh')).toBe(1)
})

test('an index that cannot be read keeps the last install counts instead of failing', async () => {
  writeSkills((await fetchOne(repo())).skills!)
  resetSkillIndex()
  index = null
  const fetched = await fetchOne(repo())
  expect(fetched.snapshot.errors).toBeUndefined()
  expect(fetched.snapshot.metrics.skillInstalls).toBe(3)
})

test('a repo without skills carries no skill metrics and never asks the index', async () => {
  globalThis.fetch = (async (input: URL | string) => {
    requested.push(input.toString())
    return json(input.toString().includes('/git/trees/') ? { tree: [] } : [])
  }) as typeof fetch
  const fetched = await fetchOne(repo())
  expect('skills' in fetched.snapshot.metrics).toBe(false)
  expect(count('skills.sh')).toBe(0)
})
