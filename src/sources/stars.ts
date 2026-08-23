import { getJson } from '../core/http.ts'
import type { Curve } from '../core/types.ts'
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
 */
type Stargazer = { starred_at: string }

/**
 * Without this exact media type the endpoint returns plain user objects with no
 * starred_at at all. It fails silently, which is the single easiest hour to lose here.
 */
const ACCEPT = 'application/vnd.github.v3.star+json'

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
): Promise<{ items: Stargazer[]; link: string | null }> {
  const { data, headers } = await getJson<Stargazer[]>(
    `${API}/repos/${repo}/stargazers?per_page=${PER_PAGE}&page=${number}`,
    options(),
  )
  return { items: data ?? [], link: headers.get('link') }
}

export async function fetchCurve(repo: Repo): Promise<Curve> {
  const id = `gh:${repo.full_name}`
  const total = repo.stargazers_count
  if (total === 0) {
    return { id, fetchedAt: new Date().toISOString(), points: [] }
  }

  const first = await page(repo.full_name, 1)
  const pageCount = lastPageFrom(first.link)
  const points: { date: string; stars: number }[] = []

  if (pageCount < SAMPLES) {
    // Small repo: every page is cheap, so walk them and stride the flattened array. The
    // cumulative count of the nth stargazer is simply n.
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) => page(repo.full_name, i + 2)),
    )
    const all = [first, ...rest].flatMap((result) => result.items)
    for (const i of sampleIndexes(all.length)) {
      points.push({ date: all[i]!.starred_at, stars: i + 1 })
    }
  } else {
    // Large repo: sample evenly spaced pages and read only their first entry, whose
    // cumulative count is 100 * (page - 1). Page 1 is forced in so the curve starts at
    // the repo's beginning rather than at the first sampled page.
    const step = pageCount / SAMPLES
    const wanted = [
      ...new Set([1, ...Array.from({ length: SAMPLES }, (_, i) => Math.round((i + 1) * step))]),
    ]
      .filter((number) => number >= 1 && number <= pageCount)
      .toSorted((a, b) => a - b)
    const sampled = await Promise.all(
      wanted.map(async (number) => ({
        number,
        items: number === 1 ? first.items : (await page(repo.full_name, number)).items,
      })),
    )
    for (const { number, items } of sampled) {
      const head = items[0]
      if (head) points.push({ date: head.starred_at, stars: PER_PAGE * (number - 1) })
    }
  }

  // The sampling arithmetic tops out below the real total, so the curve undershoots and
  // ends wrong unless the live count is pinned on as the final point.
  points.push({ date: new Date().toISOString(), stars: total })

  return {
    id,
    fetchedAt: new Date().toISOString(),
    points: points.toSorted((a, b) => a.date.localeCompare(b.date)),
  }
}
