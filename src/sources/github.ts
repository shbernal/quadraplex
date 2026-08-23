import { execFileSync } from 'node:child_process'
import { getJson } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import type { Descriptor, Fetched, Source } from './types.ts'

const API = 'https://api.github.com'
const ACCEPT = 'application/vnd.github+json'

export type Repo = {
  full_name: string
  html_url: string
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  pushed_at: string | null
  default_branch: string
  archived: boolean
  fork: boolean
  description: string | null
  homepage: string | null
}

type Issue = {
  number: number
  title: string
  html_url: string
  created_at: string
  updated_at: string
  comments: number
  body: string | null
  user: { login: string } | null
  labels: ({ name: string } | string)[]
  pull_request?: unknown
  draft?: boolean
}

export type IssueDetail = {
  number: number
  title: string
  url: string
  author: string
  createdAt: string
  updatedAt: string
  comments: number
  labels: string[]
  kind: 'issue' | 'pr'
  draft: boolean
  body: string
}

let tokenCache: string | null | undefined

/**
 * A token only ever buys rate limit and an exact issue split on busy repos. Everything
 * this tool reads is public, so an absent token degrades the numbers it labels and never
 * removes a feature.
 */
export function githubToken(): string | undefined {
  if (tokenCache !== undefined) return tokenCache ?? undefined
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (fromEnv) {
    tokenCache = fromEnv
    return fromEnv
  }
  try {
    const output = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    tokenCache = output.trim() || null
  } catch {
    tokenCache = null
  }
  return tokenCache ?? undefined
}

export function resetTokenCache(): void {
  tokenCache = undefined
}

function get<T>(path: string, conditional = true) {
  const options: Parameters<typeof getJson>[1] = { accept: ACCEPT, conditional }
  const token = githubToken()
  if (token) options.token = token
  return getJson<T>(`${API}${path}`, options)
}

async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.github
  if (!account) return []
  const out: Descriptor[] = []
  for (let page = 1; ; page++) {
    const { data } = await get<Repo[]>(
      `/users/${encodeURIComponent(account)}/repos?type=owner&per_page=100&page=${page}`,
      false,
    )
    const repos = data ?? []
    for (const repo of repos) out.push({ name: repo.full_name, discovered: 'auto', hint: repo })
    if (repos.length < 100) break
  }
  return out
}

const ISSUE_PAGE = 100

/**
 * One list call gives the exact issue and pull request split and the modal's contents at
 * the same time, which beats a search query per repo and works without a token. It is
 * only spent on repos that actually have something open, and the split is reported as
 * unknown rather than guessed when a repo has more open items than one page holds.
 */
async function issues(repo: string, count: number) {
  if (count === 0) return { items: [] as IssueDetail[], complete: true }
  const { data, notModified } = await get<Issue[]>(
    `/repos/${repo}/issues?state=open&per_page=${ISSUE_PAGE}&sort=updated`,
  )
  if (notModified) return { items: null, complete: true }
  const raw = data ?? []
  const items = raw.map((issue): IssueDetail => ({
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    author: issue.user?.login ?? 'unknown',
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    comments: issue.comments,
    labels: issue.labels.map((label) => (typeof label === 'string' ? label : label.name)),
    kind: issue.pull_request ? 'pr' : 'issue',
    draft: Boolean(issue.draft),
    body: issue.body ?? '',
  }))
  return { items, complete: raw.length < ISSUE_PAGE }
}

async function fetchOne(
  descriptor: Descriptor,
  _config: Config,
  previous?: Snapshot,
): Promise<Fetched> {
  const name = descriptor.name
  let repo = descriptor.hint as Repo | undefined

  if (!repo) {
    const response = await get<Repo>(`/repos/${name}`)
    if (response.notModified && previous) {
      // A 304 is a confirmation that the stored numbers are current, so the target is
      // freshly verified even though nothing was transferred.
      return { snapshot: { ...previous, fetchedAt: new Date().toISOString() } }
    }
    if (!response.data) throw new Error(`no repository data for ${name}`)
    repo = response.data
  }

  const open = await issues(name, repo.open_issues_count)
  const items = open.items ?? []
  const known = open.items !== null && open.complete
  const prs = items.filter((item) => item.kind === 'pr').length

  const snapshot: Snapshot = {
    id: targetId('github', name),
    ecosystem: 'github',
    name,
    url: repo.html_url,
    discovered: descriptor.discovered,
    metrics: {
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      // open_issues_count counts pull requests too. It is never presented as an issue
      // count, and the split is only filled in when it was actually counted.
      openIssuesAndPRs: repo.open_issues_count,
      openIssues: known ? items.length - prs : null,
      openPRs: known ? prs : null,
      lastPush: repo.pushed_at,
      defaultBranch: repo.default_branch,
      archived: repo.archived ? 'yes' : 'no',
    },
    links: [],
    fetchedAt: new Date().toISOString(),
  }

  const fetched: Fetched = { snapshot }
  if (open.items) fetched.detail = { items: open.items, complete: open.complete }
  return fetched
}

export const githubSource: Source = {
  ecosystem: 'github',
  discover,
  fetch: fetchOne,
}
