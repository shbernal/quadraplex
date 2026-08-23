export const SCHEMA_VERSION = 2

export type Ecosystem = 'npm' | 'pypi' | 'github' | 'amo' | 'cws'

export const ECOSYSTEMS: Ecosystem[] = ['npm', 'pypi', 'github', 'amo', 'cws']

export type MetricValue = number | string | null

/** One measurement of one target, appended to snapshots.jsonl and never rewritten. */
export type Snapshot = {
  id: string
  ecosystem: Ecosystem
  name: string
  url: string
  discovered: 'auto' | 'config'
  metrics: Record<string, MetricValue>
  links: string[]
  /** When the values in `metrics` were actually obtained. Staleness is measured from it. */
  fetchedAt: string
  /** When the last attempt happened, present only when that attempt failed. */
  attemptedAt?: string
  errors?: string[]
}

/** A snapshot plus everything derived from history and the clock. */
export type Target = Snapshot & {
  deltas: Record<string, number | null> | null
  deltaBaselineAt?: string
  stale: boolean
}

export type State = {
  schemaVersion: number
  generatedAt: string
  targets: Target[]
}

/** Per-day download counts, refetched from the registry rather than accumulated. */
export type SeriesPoint = { date: string; downloads: number }

export type Curve = {
  id: string
  fetchedAt: string
  points: { date: string; stars: number }[]
}

/** Which metric leads a target's row and its one-line summary. */
export const HEADLINE_METRIC: Record<Ecosystem, string> = {
  npm: 'downloadsWeek',
  pypi: 'downloadsWeek',
  github: 'stars',
  amo: 'users',
  cws: 'users',
}

export function targetId(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem === 'github' ? 'gh' : ecosystem}:${name}`
}

export function parseTargetId(id: string): { ecosystem: Ecosystem; name: string } | null {
  const at = id.indexOf(':')
  if (at < 1) return null
  const prefix = id.slice(0, at)
  const name = id.slice(at + 1)
  if (!name) return null
  if (prefix === 'gh') return { ecosystem: 'github', name }
  if (prefix === 'npm' || prefix === 'pypi' || prefix === 'amo' || prefix === 'cws') {
    return { ecosystem: prefix, name }
  }
  return null
}
