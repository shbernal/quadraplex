import { execFileSync } from 'node:child_process'
import { getJson, HttpError } from '../core/http.ts'
import { expired, readReleases } from '../core/store.ts'
import { targetId, type MetricValue, type Releases, type Snapshot } from '../core/types.ts'
import { ttlMs, type Config } from '../core/config.ts'
import { fetchSkills, skillMetrics } from './skills.ts'
import { orGone, revalidated, type Descriptor, type Fetched, type Source } from './types.ts'

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

type Release = {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  published_at: string | null
  assets: { name: string; download_count: number }[]
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

/** One request that says whether a login exists and how much it has published. */
export async function publicRepos(login: string): Promise<number> {
  const { data } = await get<{ public_repos: number }>(`/users/${encodeURIComponent(login)}`, false)
  return data?.public_repos ?? 0
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
async function issues(repo: string, count: number, counted: boolean) {
  if (count === 0) return { items: [] as IssueDetail[], complete: true }
  const path = `/repos/${repo}/issues?state=open&per_page=${ISSUE_PAGE}&sort=updated`
  let response = await get<Issue[]>(path)
  // A 304 only helps when the previous snapshot holds a split to carry over. Without one,
  // the list is asked for again in full, or a split lost once would stay lost until the
  // list next changed.
  if (response.notModified && !counted) response = await get<Issue[]>(path, false)
  const { data, notModified } = response
  if (notModified) return { items: null, complete: true, unchanged: true }
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

const RELEASE_PAGE = 100

/** Files that ride along with a release to verify it. Nobody downloads them to run anything. */
const VERIFICATION =
  /(sha\d*sums?|checksums?)(\.txt)?$|\.(sha\d+|sig|asc|pem|sbom|spdx|cdx\.json|intoto\.jsonl)$/i

function readRelease(releases: Release[], id: string, fetchedAt: string): Releases {
  const published = releases.filter((release) => !release.draft && release.published_at)
  const latest = published.find((release) => !release.prerelease)
  const counted = (release: Release) =>
    release.assets.filter((asset) => !VERIFICATION.test(asset.name))
  return {
    id,
    fetchedAt,
    latest: latest
      ? {
          tag: latest.tag_name,
          url: latest.html_url,
          publishedAt: latest.published_at!,
          assets: counted(latest)
            .map((asset) => ({ name: asset.name, downloads: asset.download_count }))
            .toSorted((a, b) => b.downloads - a.downloads),
        }
      : null,
    downloads: published.flatMap(counted).reduce((total, asset) => total + asset.download_count, 0),
    count: published.length,
    ahead: null,
  }
}

/**
 * Download counts move without a push, so releases are reread once per TTL, and sooner when
 * the repo was pushed since, which is what publishing a tag does. That keeps an anonymous
 * refresh to one request per repo per day rather than per hour. The first page is
 * conditional, so on a busy portfolio with a token most rereads are a free 304.
 *
 * A release can land after the push that tagged it, as when CI creates it, and a read
 * between the two would otherwise stand until the TTL. A fresh fetch rereads regardless.
 */
async function fetchReleases(repo: Repo, config: Config, fresh: boolean): Promise<Releases> {
  const id = targetId('github', repo.full_name)
  const stored = readReleases(id)
  const now = Date.now()
  const pushedSince =
    stored && repo.pushed_at && Date.parse(repo.pushed_at) > Date.parse(stored.fetchedAt)
  if (
    stored &&
    !fresh &&
    !pushedSince &&
    !expired(stored.fetchedAt, ttlMs(config, 'releases'), now)
  ) {
    return stored
  }
  const fetchedAt = new Date(now).toISOString()
  const path = (page: number) =>
    `/repos/${repo.full_name}/releases?per_page=${RELEASE_PAGE}&page=${page}`
  const first = await get<Release[]>(path(1), stored !== null && !fresh)
  const reading = first.notModified && stored ? { ...stored, fetchedAt } : await readAll()
  return { ...reading, ahead: await ahead(repo, reading.latest?.tag) }

  async function readAll(): Promise<Releases> {
    const all = (first.notModified ? (await get<Release[]>(path(1), false)).data : first.data) ?? []
    for (let page = 2, last = all.length; last === RELEASE_PAGE; page++) {
      const more = (await get<Release[]>(path(page), false)).data ?? []
      all.push(...more)
      last = more.length
    }
    return readRelease(all, id, fetchedAt)
  }
}

/**
 * Commits the default branch holds past the release tag. It only moves with a push or a new
 * release, which is exactly when releases are reread, so it rides on that schedule for one
 * request more. A tag deleted since reads as unknown.
 */
async function ahead(repo: Repo, tag: string | undefined): Promise<number | null> {
  if (!tag) return null
  const base = encodeURIComponent(tag)
  const head = encodeURIComponent(repo.default_branch)
  try {
    const response = await get<{ ahead_by?: number }>(
      `/repos/${repo.full_name}/compare/${base}...${head}?per_page=1`,
      false,
    )
    return typeof response.data?.ahead_by === 'number' ? response.data.ahead_by : null
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 422)) return null
    throw error
  }
}

/** A tag that reads as a version, without the "v" registries never print. */
function versionOf(tag: string): string | null {
  return /^v?(\d+(\.\d+)*([-+].+)?)$/.exec(tag)?.[1] ?? null
}

/**
 * Only a repo that has released carries these, so the rest are not padded with empty
 * rows. A tag that is not a version, as a monorepo's `pkg@1.2.0`, still dates the release.
 */
function releaseMetrics(reading: Releases | null): Record<string, MetricValue> {
  if (!reading?.count) return {}
  return {
    version: reading.latest ? versionOf(reading.latest.tag) : null,
    lastPublish: reading.latest?.publishedAt ?? null,
    downloadsTotal: reading.downloads,
    ...(reading.latest ? { unreleasedCommits: reading.ahead } : {}),
  }
}

async function fetchOne(
  descriptor: Descriptor,
  config: Config,
  previous?: Snapshot,
): Promise<Fetched> {
  const name = descriptor.name
  let repo = descriptor.hint as Repo | undefined

  if (!repo) {
    // A 304 would answer with the previous snapshot, releases and all.
    let response = await orGone(get<Repo>(`/repos/${name}`, !descriptor.fresh))
    if (response.notModified && previous) return { snapshot: revalidated(previous) }
    // An ETag outliving the snapshot it vouched for is a cache miss, never an error.
    if (response.notModified) response = await get<Repo>(`/repos/${name}`, false)
    if (!response.data) throw new Error(`no repository data for ${name}`)
    repo = response.data
  }

  // A repo the state will drop still gets a snapshot, so it stays current and an
  // unarchive is noticed, but its issue list is never read and never displayed.
  const dropped = (repo.archived && !config.includeArchived) || (repo.fork && !config.includeForks)
  const open = dropped
    ? { items: null, complete: false }
    : await issues(name, repo.open_issues_count, typeof previous?.metrics.openPRs === 'number')
  const items = open.items ?? []
  const known = open.items !== null && open.complete
  const prs = items.filter((item) => item.kind === 'pr').length
  // A 304 means the list is the one already counted, so its split carries over. The
  // stored detail file is left alone for the same reason.
  const kept = 'unchanged' in open && previous ? previous.metrics : null
  // A dropped repo is not something you publish, so it pays for no releases either.
  const released = dropped ? null : await fetchReleases(repo, config, descriptor.fresh === true)
  const skills = dropped ? null : await fetchSkills(repo, get)

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
      openIssues: kept ? (kept.openIssues ?? null) : known ? items.length - prs : null,
      openPRs: kept ? (kept.openPRs ?? null) : known ? prs : null,
      lastPush: repo.pushed_at,
      defaultBranch: repo.default_branch,
      archived: repo.archived ? 'yes' : 'no',
      fork: repo.fork ? 'yes' : 'no',
      ...releaseMetrics(released),
      ...skillMetrics(skills),
    },
    links: [],
    fetchedAt: new Date().toISOString(),
  }

  const fetched: Fetched = { snapshot }
  if (open.items) fetched.detail = { items: open.items, complete: open.complete }
  if (released) fetched.releases = released
  if (skills) fetched.skills = skills
  return fetched
}

export const githubSource: Source = {
  ecosystem: 'github',
  roster: true,
  discover,
  fetch: fetchOne,
}
