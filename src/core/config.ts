import { readFileSync } from 'node:fs'
import { paths } from './paths.ts'
import { ECOSYSTEMS, type Ecosystem } from './types.ts'
import { parseDuration } from './duration.ts'

export type Config = {
  accounts: Partial<Record<Ecosystem, string>>
  exclude: string[]
  include: string[]
  includeArchived: boolean
  includeForks: boolean
  links: Record<string, string[]>
  ttl: Record<Ecosystem | 'curves', string>
  deltaWindow: Record<Ecosystem, string>
}

/**
 * TTL answers "is this number old". deltaWindow answers "how far back do I compare".
 * They are separate because npm publishes daily download data but its star and issue
 * counterparts move continuously, and a delta measured over an hour is noise.
 */
export const DEFAULT_CONFIG: Config = {
  // AMO identifies an author by numeric user id, which is the only handle an account
  // without a public username has.
  accounts: { npm: 'shbernal', pypi: 'shbernal', github: 'shbernal', amo: '20068285' },
  exclude: [],
  include: [],
  includeArchived: false,
  includeForks: false,
  links: {},
  ttl: { npm: '24h', pypi: '24h', github: '1h', amo: '24h', curves: '30d' },
  deltaWindow: { npm: '24h', pypi: '24h', github: '24h', amo: '24h' },
}

export function loadConfig(): Config {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(paths.config, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG)
    throw new Error(`config at ${paths.config} is not valid JSON`, { cause: error })
  }
  const user = (raw ?? {}) as Partial<Config>
  const config: Config = {
    accounts: { ...DEFAULT_CONFIG.accounts, ...user.accounts },
    exclude: user.exclude ?? [],
    include: user.include ?? [],
    includeArchived: user.includeArchived ?? false,
    includeForks: user.includeForks ?? false,
    links: user.links ?? {},
    ttl: { ...DEFAULT_CONFIG.ttl, ...user.ttl },
    deltaWindow: { ...DEFAULT_CONFIG.deltaWindow, ...user.deltaWindow },
  }
  for (const key of [...ECOSYSTEMS, 'curves'] as const) parseDuration(config.ttl[key])
  for (const key of ECOSYSTEMS) parseDuration(config.deltaWindow[key])
  return config
}

/**
 * An archived repo and a fork are not things you publish, so they are dropped from the
 * derived state rather than from discovery. They keep being fetched, which means an
 * unarchive is picked up by the next refresh instead of leaving a target frozen in the
 * log and reported stale forever.
 */
export function hidden(
  config: Config,
  snapshot: { ecosystem: Ecosystem; metrics: Record<string, unknown> },
): boolean {
  if (snapshot.ecosystem !== 'github') return false
  if (!config.includeArchived && snapshot.metrics.archived === 'yes') return true
  if (!config.includeForks && snapshot.metrics.fork === 'yes') return true
  return false
}

export function ttlMs(config: Config, key: Ecosystem | 'curves'): number {
  return parseDuration(config.ttl[key])
}

export function deltaWindowMs(config: Config, ecosystem: Ecosystem): number {
  return parseDuration(config.deltaWindow[ecosystem])
}
