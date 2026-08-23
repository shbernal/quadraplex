import { hidden, loadConfig, ttlMs } from '../core/config.ts'
import { describe } from '../core/errors.ts'
import { flushCache, mapLimit } from '../core/http.ts'
import { expired, groupById, readCurve, readSnapshots, writeCurve } from '../core/store.ts'
import { fetchCurve } from '../sources/stars.ts'
import { githubToken, type Repo } from '../sources/github.ts'

const CONCURRENCY = 2

export type CurveReport = {
  built: string[]
  skipped: number
  /** The curve TTL in force, as configured. */
  ttl: string
  /** Repos whose last fetch left no star count, so there was nothing to sample. */
  unknown: string[]
  failed: { id: string; error: string }[]
}

/**
 * Curves are never rebuilt by a plain refresh. At about 17 requests per repo, folding
 * them into the routine command would spend an unauthenticated hourly budget in one go,
 * so this is its own command with its own 30 day TTL.
 *
 * A repo with no stars has no curve to draw and is skipped rather than requested. One
 * whose count is unknown is reported apart, since writing an empty curve for it would
 * pin a wrong answer for the whole TTL.
 */
export async function refreshCurves(): Promise<CurveReport> {
  const config = loadConfig()
  const ttl = ttlMs(config, 'curves')
  const now = Date.now()
  const report: CurveReport = {
    built: [],
    skipped: 0,
    ttl: config.ttl.curves,
    unknown: [],
    failed: [],
  }

  const repos = [...groupById(readSnapshots()).values()]
    .map((history) => history.at(-1)!)
    .filter((snapshot) => snapshot.ecosystem === 'github')
    .filter((snapshot) => !snapshot.retired && !config.exclude.includes(snapshot.id))
    .filter((snapshot) => !hidden(config, snapshot))

  await mapLimit(repos, CONCURRENCY, async (snapshot) => {
    const stars = snapshot.metrics.stars
    if (typeof stars !== 'number') {
      report.unknown.push(snapshot.id)
      return
    }
    const existing = readCurve(snapshot.id)
    if (stars === 0 || (existing && !expired(existing.fetchedAt, ttl, now))) {
      report.skipped++
      return
    }
    try {
      const repo: Repo = {
        full_name: snapshot.name,
        html_url: snapshot.url,
        stargazers_count: stars,
        forks_count: 0,
        open_issues_count: 0,
        pushed_at: null,
        default_branch: 'main',
        archived: false,
        fork: false,
        description: null,
        homepage: null,
      }
      writeCurve(await fetchCurve(repo))
      report.built.push(snapshot.id)
    } catch (error) {
      report.failed.push({
        id: snapshot.id,
        error: describe(error),
      })
    }
  })

  flushCache()
  return report
}

export function curvesSummary(report: CurveReport): string {
  const auth = githubToken() ? 'authenticated' : 'unauthenticated, 60 requests per hour'
  const lines = [
    `built ${report.built.length} curves, skipped ${report.skipped} still inside the ${report.ttl} window or with no stars (${auth})`,
  ]
  if (report.unknown.length) {
    lines.push(
      `  no star count yet, run "qplex refresh --only github": ${report.unknown.join(', ')}`,
    )
  }
  for (const failure of report.failed) lines.push(`  failed ${failure.id}: ${failure.error}`)
  return lines.join('\n')
}
