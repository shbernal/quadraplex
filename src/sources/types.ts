import type { Config } from '../core/config.ts'
import type { Ecosystem, SeriesPoint, Snapshot } from '../core/types.ts'

export type Descriptor = {
  name: string
  discovered: 'auto' | 'config'
  /** Whatever discovery already learned, so a fetch does not re-request it. */
  hint?: unknown
}

export type Fetched = {
  snapshot: Snapshot
  series?: SeriesPoint[]
  detail?: Record<string, unknown>
}

export type Source = {
  ecosystem: Ecosystem
  discover(config: Config): Promise<Descriptor[]>
  fetch(descriptor: Descriptor, config: Config): Promise<Fetched>
}

/** Pulls "owner/repo" out of any GitHub URL shape a registry might carry. */
export function githubRepoFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const match = /github\.com[/:]([^/]+)\/([^/#?]+)/.exec(url)
  if (!match) return null
  return `${match[1]}/${match[2]!.replace(/\.git$/, '')}`
}

export function sumLast(series: SeriesPoint[], days: number): number {
  return series.slice(-days).reduce((total, point) => total + point.downloads, 0)
}
