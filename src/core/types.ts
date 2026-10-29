export const SCHEMA_VERSION = 2

export type Ecosystem =
  | 'npm'
  | 'pypi'
  | 'github'
  | 'ghcr'
  | 'amo'
  | 'cws'
  | 'clawhub'
  | 'dockerhub'
  | 'rubygems'
  | 'jsr'
  | 'vscode'
  | 'openvsx'

export const ECOSYSTEMS: Ecosystem[] = [
  'npm',
  'pypi',
  'github',
  'ghcr',
  'amo',
  'cws',
  'clawhub',
  'dockerhub',
  'rubygems',
  'jsr',
  'vscode',
  'openvsx',
]

/** How usage errors name the accepted values, aliases included since they are target commands. */
export const ECOSYSTEM_CHOICES =
  'npm, pypi, github (or gh), ghcr, amo, cws, clawhub, dockerhub (or docker), rubygems (or gem), jsr, vscode, openvsx'

export function ecosystemNamed(value: unknown): Ecosystem | undefined {
  const name =
    value === 'gh'
      ? 'github'
      : value === 'docker'
        ? 'dockerhub'
        : value === 'gem'
          ? 'rubygems'
          : value
  return (ECOSYSTEMS as unknown[]).includes(name) ? (name as Ecosystem) : undefined
}

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
  /**
   * npm only: downloads per version over the registry's last 7 days, versions with none
   * left out. npm serves no history of this split, so the log is the only record of it.
   * Absent means it was not measured, not that nothing was downloaded.
   */
  versions?: Record<string, number>
  /** When the values in `metrics` were actually obtained. Staleness is measured from it. */
  fetchedAt: string
  /** When the last attempt happened, present only when that attempt failed. */
  attemptedAt?: string
  errors?: string[]
  /**
   * The target was deleted, unpublished, made private or handed to another account. The
   * values are the last ones seen, and the target is dropped from the derived state until
   * a later snapshot without this field revives it.
   */
  retired?: { at: string; reason: string }
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

/** Who starred a repo, and when. Public profile data, same as the count above it. */
export type Stargazer = { login: string; url: string; starredAt: string }

export type Curve = {
  id: string
  fetchedAt: string
  points: { date: string; stars: number }[]
  /**
   * The most recent stargazers, newest first, harvested from the very pages the curve is
   * sampled from. Absent means nobody looked, not that nobody starred, and a large repo
   * only ever knows its tail: the count in `metrics.stars` remains the total.
   */
  stargazers?: Stargazer[]
}

/** One asset of a release, named as uploaded. */
type ReleaseAsset = { name: string; downloads: number }

/**
 * A repo's GitHub Releases, read on their own TTL rather than with every hourly refresh of
 * the repo. Download counts are lifetime totals with no per-day history, so the rate comes
 * from the delta between snapshots.
 */
export type Releases = {
  id: string
  fetchedAt: string
  /** The newest published release that is not a prerelease, null when there is none. */
  latest: {
    tag: string
    url: string
    publishedAt: string
    assets: ReleaseAsset[]
  } | null
  /** Every release counted, prereleases included, and every asset bar checksums and signatures. */
  downloads: number
  count: number
  /** Commits on the default branch since the latest release's tag, null when unknown. */
  ahead: number | null
}

/** One skill as `npx skills add` would offer it, named by its frontmatter. */
export type Skill = {
  name: string
  description: string
  /** The SKILL.md in the repo, whose blob sha says whether it needs reading again. */
  path: string
  sha: string
  /** Lifetime installs on skills.sh, null when the index has never seen it installed. */
  installs: number | null
}

/**
 * The agent skills a repo publishes. The list only changes with a push, so it is reread
 * then, while install counts are refreshed with every read of the repo.
 */
export type Skills = {
  id: string
  /** When the repo's tree was last read. */
  fetchedAt: string
  skills: Skill[]
}

/** Which metric leads a target's row and its one-line summary. */
export const HEADLINE_METRIC: Record<Ecosystem, string> = {
  npm: 'downloadsWeek',
  pypi: 'downloadsWeek',
  github: 'stars',
  ghcr: 'downloadsWeek',
  amo: 'users',
  cws: 'users',
  clawhub: 'installs',
  dockerhub: 'downloadsTotal',
  rubygems: 'downloadsTotal',
  jsr: 'downloadsWeek',
  vscode: 'installs',
  openvsx: 'downloadsTotal',
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
  if (prefix !== 'github' && ECOSYSTEMS.includes(prefix as Ecosystem)) {
    return { ecosystem: prefix as Ecosystem, name }
  }
  return null
}
