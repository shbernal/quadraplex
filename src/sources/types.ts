import type { Config } from '../core/config.ts'
import { HttpError } from '../core/http.ts'
import type { Ecosystem, Releases, SeriesPoint, Skills, Snapshot } from '../core/types.ts'

export type Descriptor = {
  name: string
  discovered: 'auto' | 'config'
  /** Whatever discovery already learned, so a fetch does not re-request it. */
  hint?: unknown
  /** Named by hand with `--fresh`, so no cached reading stands in for a request. */
  fresh?: boolean
}

export type Fetched = {
  snapshot: Snapshot
  series?: SeriesPoint[]
  detail?: Record<string, unknown>
  releases?: Releases
  skills?: Skills
}

export type Source = {
  ecosystem: Ecosystem
  /**
   * Whether a discovery that returns is the account's whole portfolio, so a known target
   * missing from it is no longer published there. False where discovery is a search.
   */
  roster: boolean
  discover(config: Config): Promise<Descriptor[]>
  /** `previous` lets a source answer a 304 with the values it already had. */
  fetch(descriptor: Descriptor, config: Config, previous?: Snapshot): Promise<Fetched>
}

/**
 * A 304 confirms the stored values, so the target counts as freshly fetched. A failure or
 * a retirement the stored snapshot carried is over, so it is not copied forward.
 */
export function revalidated(previous: Snapshot): Snapshot {
  const { attemptedAt: _attempted, errors: _errors, retired: _retired, ...rest } = previous
  return { ...rest, fetchedAt: new Date().toISOString() }
}

/** Pulls "owner/repo" out of any GitHub URL shape an ecosystem's metadata might carry. */
export function githubRepoFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const match = /github\.com[/:]([^/]+)\/([^/#?]+)/.exec(url)
  if (!match) return null
  return `${match[1]}/${match[2]!.replace(/\.git$/, '')}`
}

export function sumLast(series: SeriesPoint[], days: number): number {
  return series.slice(-days).reduce((total, point) => total + point.downloads, 0)
}

/** A discovery that found targets but cannot vouch for the ones it did not find. */
export class PartialDiscovery extends Error {
  constructor(
    readonly found: Descriptor[],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** The store answered that the target is gone or no longer the account's, not that it failed. */
export class Gone extends Error {}

/**
 * Only the request for the target's own resource may declare it gone. A stats service
 * that has not caught up with a new package answers 404 as well.
 */
export async function orGone<T>(request: Promise<T>): Promise<T> {
  try {
    return await request
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new Gone(error.message, { cause: error })
    }
    throw error
  }
}
