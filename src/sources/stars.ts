import { getJson } from '../core/http.ts'
import type { Curve, Stargazer } from '../core/types.ts'
import { githubToken, type Repo } from './github.ts'

const API = 'https://api.github.com'
const PER_PAGE = 100
const SAMPLES = 16

/**
 * Ported from star-history/star-history, `shared/common/api.tsx`, MIT and copyright Star
 * History. Attribution is in LICENSE.
 *
 * A whole star curve costs about 17 requests whether the repo has 200 stars or 200k,
 * because pages are sampled rather than walked. Paginating every stargazer instead would
 * be thousands of requests on a large repo.
 *
 * Every page already carries who starred alongside when, so the identities behind the
 * curve are harvested from the same responses and cost nothing on top of it.
 */
type Entry = { starred_at: string; user?: { login?: string; html_url?: string } | null }

/**
 * Without this exact media type the endpoint returns plain user objects with no
 * starred_at at all. It fails silently, which is the single easiest hour to lose here.
 */
const ACCEPT = 'application/vnd.github.v3.star+json'

const RECENT = 100

/**
 * Newest first, capped. An entry with no user object is dropped rather than shown as
 * someone unnamed, so the list is short and honest instead of long and padded.
 */
export function recentStargazers(entries: Entry[], limit = RECENT): Stargazer[] {
  const byLogin = new Map<string, Stargazer>()
  for (const entry of entries) {
    const login = entry.user?.login
    if (!login || !entry.starred_at) continue
    const seen = byLogin.get(login)
    if (seen && seen.starredAt >= entry.starred_at) continue
    byLogin.set(login, {
      login,
      url: entry.user?.html_url ?? `https://github.com/${login}`,
      starredAt: entry.starred_at,
    })
  }
  return [...byLogin.values()]
    .toSorted((a, b) => b.starredAt.localeCompare(a.starredAt))
    .slice(0, limit)
}

function options() {
  const token = githubToken()
  return token ? { accept: ACCEPT, token } : { accept: ACCEPT }
}

export function lastPageFrom(link: string | null): number {
  const match = link ? /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link) : null
  return match ? Number(match[1]) : 1
}

/**
 * Evenly spaced page numbers with page 1 forced in, so the curve starts at the repo's
 * beginning rather than at the first sampled page.
 */
export function samplePages(pageCount: number, samples = SAMPLES): number[] {
  const step = pageCount / samples
  const wanted = new Set([
    1,
    ...Array.from({ length: samples }, (_, i) => Math.round((i + 1) * step)),
  ])
  return [...wanted]
    .filter((number) => number >= 1 && number <= pageCount)
    .toSorted((a, b) => a - b)
}

/** Indexes into the flattened stargazer list for the small repo path. */
export function sampleIndexes(length: number, samples = SAMPLES): number[] {
  const step = Math.max(Math.floor(length / samples), 1)
  const out: number[] = []
  for (let i = 0; i < length; i += step) out.push(i)
  return out
}

async function page(
  repo: string,
  number: number,
): Promise<{ items: Entry[]; link: string | null }> {
  const { data, headers } = await getJson<Entry[]>(
    `${API}/repos/${repo}/stargazers?per_page=${PER_PAGE}&page=${number}`,
    options(),
  )
  return { items: data ?? [], link: headers.get('link') }
}

export async function fetchCurve(repo: Repo): Promise<Curve> {
  const id = `gh:${repo.full_name}`
  const total = repo.stargazers_count
  if (total === 0) {
    return { id, fetchedAt: new Date().toISOString(), points: [], stargazers: [] }
  }

  const first = await page(repo.full_name, 1)
  const pageCount = lastPageFrom(first.link)
  const points: { date: string; stars: number }[] = []
  let seen: Entry[] = []

  if (pageCount < SAMPLES) {
    // Small repo: every page is cheap, so walk them and stride the flattened array. The
    // cumulative count of the nth stargazer is simply n.
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) => page(repo.full_name, i + 2)),
    )
    const all = [first, ...rest].flatMap((result) => result.items)
    seen = all
    for (const i of sampleIndexes(all.length)) {
      points.push({ date: all[i]!.starred_at, stars: i + 1 })
    }
  } else {
    // Large repo: sample evenly spaced pages, whose first entry has a cumulative count of
    // 100 * (page - 1). Page 1 is forced in so the curve starts at the repo's beginning
    // rather than at the first sampled page, and the last page is always sampled too,
    // which is where the most recent stargazers come from.
    const sampled = await Promise.all(
      samplePages(pageCount).map(async (number) => ({
        number,
        items: number === 1 ? first.items : (await page(repo.full_name, number)).items,
      })),
    )
    for (const { number, items } of sampled) {
      const head = items[0]
      if (head) points.push({ date: head.starred_at, stars: PER_PAGE * (number - 1) })
    }
    // Only the first entry of a page shapes the curve, but the whole page was transferred
    // and every name on it is already paid for.
    seen = sampled.flatMap((result) => result.items)
  }

  // The sampling arithmetic tops out below the real total, so the curve undershoots and
  // ends wrong unless the live count is pinned on as the final point.
  points.push({ date: new Date().toISOString(), stars: total })

  return {
    id,
    fetchedAt: new Date().toISOString(),
    points: points.toSorted((a, b) => a.date.localeCompare(b.date)),
    stargazers: recentStargazers(seen),
  }
}
