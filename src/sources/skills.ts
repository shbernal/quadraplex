import { getJson, getText, HttpError, type Response } from '../core/http.ts'
import { readSkills } from '../core/store.ts'
import { targetId, type MetricValue, type Skill, type Skills } from '../core/types.ts'

type Get = <T>(path: string, conditional?: boolean) => Promise<Response<T>>

type Tree = { tree?: { path: string; type: string; sha: string }[]; truncated?: boolean }

type Indexed = { id: string; installs: number }

/** Where `npx skills add` looks first, the root included. */
const CONTAINERS = /^(|skills\/(\.(curated|experimental|system)\/)?)$/
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__'])

/**
 * The SKILL.md files the skills CLI would install from this tree, by its own rules: a
 * skill at the root or one directory down, or up to three directories into a skills
 * folder, not nested under another skill. A repo with none of those falls back to any
 * SKILL.md within five directories. A top-level dot directory such as `.claude/skills` holds
 * what the repo installs for its own agents, not what it publishes, so it is never counted.
 */
export function skillPaths(paths: string[]): string[] {
  const all = paths.filter((p) => /(^|\/)skill\.md$/i.test(p) && !p.startsWith('.'))
  const lower = new Set(all.map((p) => p.toLowerCase()))
  const preferred = all.filter((p) => {
    const dirs = p.split('/').slice(0, -1)
    return dirs.concat('').some((_dir, cut) => {
      const prefix = dirs.slice(0, cut).join('/') + (cut ? '/' : '')
      if (!CONTAINERS.test(prefix)) return false
      const rest = dirs.slice(cut)
      if (rest.length <= 1) return true
      if (!prefix || rest.length > 3 || rest.some((d) => SKIP.has(d))) return false
      return !rest
        .slice(0, -1)
        .some((_ancestor, i) => lower.has(`${prefix}${rest.slice(0, i + 1).join('/')}/skill.md`))
    })
  })
  return preferred.length ? preferred : all.filter((p) => p.split('/').length <= 6)
}

const unquote = (v: string) => v.replace(/^(['"])(.*)\1$/, '$2').trim()

/**
 * Enough YAML for the fields the CLI requires: a top-level scalar, quoted or folded, and
 * `metadata.internal`, which hides a skill from installs.
 */
export function frontmatter(text: string): {
  name?: string
  description?: string
  internal: boolean
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: { name?: string; description?: string; internal: boolean } = { internal: false }
  if (!match) return out
  const lines = match[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description|metadata):\s*(.*)$/.exec(lines[i]!)
    if (!field) continue
    const block: string[] = []
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim())
    const [, key, value] = field
    if (key === 'metadata') out.internal = block.some((l) => /^internal:\s*true\s*$/.test(l))
    else
      out[key as 'name' | 'description'] = /^[>|]/.test(value!) ? block.join(' ') : unquote(value!)
  }
  return out
}

const indexes = new Map<string, Promise<Map<string, number> | null>>()

/**
 * skills.sh counts an install when `npx skills add` reports one, so it only knows a skill
 * somebody has installed. One search per account and process covers every repo, and a
 * failure reads as unknown rather than costing the repo its refresh.
 */
function installIndex(owner: string): Promise<Map<string, number> | null> {
  const key = owner.toLowerCase()
  let index = indexes.get(key)
  if (!index) {
    const url = `https://skills.sh/api/search?q=${encodeURIComponent(owner)}&owner=${encodeURIComponent(owner)}&limit=200`
    index = getJson<{ skills?: Indexed[] }>(url, { attempts: 2 })
      .then(
        ({ data }) => new Map((data?.skills ?? []).map((s) => [s.id.toLowerCase(), s.installs])),
      )
      .catch(() => null)
    indexes.set(key, index)
  }
  return index
}

export function resetSkillIndex(): void {
  indexes.clear()
}

/** skills.sh keys a skill by its frontmatter name, lowercased and hyphenated. */
export const skillSlug = (name: string) => name.toLowerCase().replace(/[\s_]+/g, '-')

async function readSkill(
  repo: string,
  branch: string,
  entry: { path: string; sha: string },
): Promise<Skill | null> {
  const encoded = [repo, branch, entry.path].map((p) =>
    p.split('/').map(encodeURIComponent).join('/'),
  )
  const { data } = await getText(`https://raw.githubusercontent.com/${encoded.join('/')}`, {
    accept: 'text/plain',
  })
  const meta = frontmatter(data ?? '')
  if (!meta.name || !meta.description || meta.internal) return null
  return {
    name: meta.name,
    description: meta.description,
    path: entry.path,
    sha: entry.sha,
    installs: null,
  }
}

type RepoRef = { full_name: string; default_branch: string; pushed_at: string | null }

/**
 * The tree is reread only when nothing is stored or the repo was pushed since, and a
 * SKILL.md whose blob is unchanged is not downloaded again. Files are read from
 * raw.githubusercontent.com, which does not draw on the API's rate limit.
 */
export async function fetchSkills(repo: RepoRef, get: Get): Promise<Skills> {
  const id = targetId('github', repo.full_name)
  const stored = readSkills(id)
  const pushedSince =
    !stored ||
    (repo.pushed_at !== null && Date.parse(repo.pushed_at) > Date.parse(stored.fetchedAt))
  let skills = stored?.skills ?? []
  let fetchedAt = stored?.fetchedAt ?? new Date().toISOString()
  if (pushedSince) {
    fetchedAt = new Date().toISOString()
    const path = `/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`
    let tree: Response<Tree> | null
    try {
      tree = await get<Tree>(path, stored !== null)
    } catch (error) {
      // An empty repo has no tree to list, which GitHub answers with 409.
      if (!(error instanceof HttpError && (error.status === 404 || error.status === 409)))
        throw error
      tree = null
    }
    if (!tree?.notModified) {
      const known = new Map(skills.map((s) => [s.path, s]))
      const entries = (tree?.data?.tree ?? []).filter((e) => e.type === 'blob')
      const shas = new Map(entries.map((e) => [e.path, e.sha]))
      const read = await Promise.all(
        skillPaths(entries.map((e) => e.path)).map((p) => {
          const entry = { path: p, sha: shas.get(p)! }
          const same = known.get(p)
          return same?.sha === entry.sha
            ? Promise.resolve(same)
            : readSkill(repo.full_name, repo.default_branch, entry)
        }),
      )
      const seen = new Set<string>()
      skills = read.filter((s): s is Skill => s !== null && !seen.has(s.name) && !!seen.add(s.name))
    }
  }
  // A failed index keeps the last counts seen. A skill it does not list has none.
  const index = skills.length ? await installIndex(repo.full_name.split('/')[0]!) : null
  if (index) {
    for (const s of skills)
      s.installs = index.get(`${repo.full_name}/${skillSlug(s.name)}`.toLowerCase()) ?? null
  }
  return { id, fetchedAt, skills }
}

/** Only a repo that publishes skills carries these, so the rest are not padded with zeros. */
export function skillMetrics(reading: Skills | null): Record<string, MetricValue> {
  if (!reading?.skills.length) return {}
  const counted = reading.skills.flatMap((s) => (s.installs === null ? [] : [s.installs]))
  return {
    skills: reading.skills.length,
    skillInstalls: counted.length ? counted.reduce((a, b) => a + b, 0) : null,
  }
}
