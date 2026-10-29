import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './paths.ts'
import { ECOSYSTEMS, parseTargetId, type Ecosystem } from './types.ts'
import { parseDuration } from './duration.ts'

export type Config = {
  accounts: Partial<Record<Ecosystem, string>>
  exclude: string[]
  include: string[]
  includeArchived: boolean
  includeDeprecated: boolean
  includeForks: boolean
  links: Record<string, string[]>
  ttl: Record<Ecosystem | 'curves' | 'releases', string>
  deltaWindow: Record<Ecosystem, string>
}

/**
 * TTL answers "is this number old". deltaWindow answers "how far back do I compare".
 * They are separate because npm publishes daily download data but its star and issue
 * counterparts move continuously, and a delta measured over an hour is noise.
 */
export const DEFAULT_CONFIG: Config = {
  // AMO identifies an author by numeric user id, which is the only handle an account
  // without a public username has. The Chrome Web Store one is the "Offered by" name.
  accounts: {},
  exclude: [],
  include: [],
  includeArchived: false,
  includeDeprecated: false,
  includeForks: false,
  links: {},
  ttl: {
    npm: '24h',
    pypi: '24h',
    github: '1h',
    ghcr: '24h',
    amo: '24h',
    cws: '24h',
    clawhub: '24h',
    dockerhub: '24h',
    rubygems: '24h',
    jsr: '24h',
    vscode: '24h',
    openvsx: '24h',
    aur: '24h',
    packagist: '24h',
    nuget: '24h',
    crates: '24h',
    curves: '30d',
    releases: '24h',
  },
  deltaWindow: {
    npm: '24h',
    pypi: '24h',
    github: '24h',
    ghcr: '24h',
    amo: '24h',
    cws: '24h',
    clawhub: '24h',
    dockerhub: '24h',
    rubygems: '24h',
    jsr: '24h',
    vscode: '24h',
    openvsx: '24h',
    aur: '24h',
    packagist: '24h',
    nuget: '24h',
    crates: '24h',
  },
}

/** The config file existing is what marks an install as set up. */
export function configured(): boolean {
  return existsSync(paths.config)
}

/** An ecosystem is in the portfolio when it has an account or an `include` entry. */
export function configuredEcosystems(config: Config): Set<Ecosystem> {
  const out = new Set(Object.keys(config.accounts) as Ecosystem[])
  for (const id of config.include) {
    const parsed = parseTargetId(id)
    if (parsed) out.add(parsed.ecosystem)
  }
  return out
}

/** The file as written, or undefined when there is none. */
function readRaw(): unknown {
  try {
    return JSON.parse(readFileSync(paths.config, 'utf8')) ?? {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`config at ${paths.config} is not valid JSON`, { cause: error })
  }
}

export function loadConfig(): Config {
  const raw = readRaw()
  if (raw === undefined) return structuredClone(DEFAULT_CONFIG)
  const user = validate(raw)
  return {
    accounts: user.accounts ?? {},
    exclude: user.exclude ?? [],
    include: user.include ?? [],
    includeArchived: user.includeArchived ?? false,
    includeDeprecated: user.includeDeprecated ?? false,
    includeForks: user.includeForks ?? false,
    links: user.links ?? {},
    ttl: { ...DEFAULT_CONFIG.ttl, ...user.ttl },
    deltaWindow: { ...DEFAULT_CONFIG.deltaWindow, ...user.deltaWindow },
  }
}

/**
 * Sets accounts, or removes one given an empty string, and keeps every other key as the
 * file had it. The result is validated like a load and lands whole or not at all, so an
 * interrupted save never leaves a half-written file behind.
 */
export function saveAccounts(changes: Partial<Record<Ecosystem, string>>): Config {
  const raw = readRaw() ?? {}
  const current = validate(raw)
  const accounts = { ...current.accounts }
  for (const [ecosystem, value] of Object.entries(changes) as [Ecosystem, string][]) {
    if (value) accounts[ecosystem] = value
    else delete accounts[ecosystem]
  }
  const next = validate({ ...current, accounts })
  mkdirSync(dirname(paths.config), { recursive: true })
  const temp = `${paths.config}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(temp, paths.config)
  return loadConfig()
}

const KEYS = new Set(Object.keys(DEFAULT_CONFIG))

function fail(key: string, expected: string): never {
  throw new Error(`config at ${paths.config}: "${key}" ${expected}`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function targetIds(key: string, value: unknown): void {
  if (!Array.isArray(value)) fail(key, 'must be an array of target ids')
  for (const entry of value) {
    if (typeof entry !== 'string' || !parseTargetId(entry)) {
      fail(key, `has ${JSON.stringify(entry)}, expected a target id such as "npm:name"`)
    }
  }
}

function keyed(
  key: string,
  value: unknown,
  allowed: readonly string[],
  each: (key: string, value: unknown) => void,
): void {
  if (!isObject(value)) fail(key, 'must be an object')
  for (const [name, entry] of Object.entries(value)) {
    if (!allowed.includes(name)) fail(`${key}.${name}`, `is not one of ${allowed.join(', ')}`)
    each(`${key}.${name}`, entry)
  }
}

function duration(key: string, value: unknown): void {
  if (typeof value !== 'string') fail(key, 'must be a duration such as "24h"')
  try {
    parseDuration(value)
  } catch (error) {
    fail(key, (error as Error).message)
  }
}

/**
 * The file is hand-edited and decides which projects are visible, and `links` is copied
 * into the append-only log. So a wrong type is rejected with the key named, never coerced:
 * the string "false" is truthy, and a string `exclude` would match by substring.
 */
function validate(raw: unknown): Partial<Config> {
  if (!isObject(raw)) fail('', 'must hold a JSON object')
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) fail(key, `is not a setting, expected one of ${[...KEYS].join(', ')}`)
  }
  if (raw.accounts !== undefined) {
    keyed('accounts', raw.accounts, ECOSYSTEMS, (key, value) => {
      if (typeof value !== 'string' || !value) fail(key, 'must be a non-empty string')
    })
  }
  if (raw.include !== undefined) targetIds('include', raw.include)
  if (raw.exclude !== undefined) targetIds('exclude', raw.exclude)
  for (const key of ['includeArchived', 'includeDeprecated', 'includeForks']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') fail(key, 'must be true or false')
  }
  if (raw.links !== undefined) {
    if (!isObject(raw.links)) fail('links', 'must be an object of target id to target ids')
    for (const [id, linked] of Object.entries(raw.links)) {
      if (!parseTargetId(id)) fail(`links.${id}`, 'is not a target id')
      targetIds(`links.${id}`, linked)
    }
  }
  if (raw.ttl !== undefined) keyed('ttl', raw.ttl, [...ECOSYSTEMS, 'curves', 'releases'], duration)
  if (raw.deltaWindow !== undefined) keyed('deltaWindow', raw.deltaWindow, ECOSYSTEMS, duration)
  return raw
}

/**
 * An archived repo, a fork and a deprecated package are not things you publish, so they
 * are dropped from the derived state rather than from discovery. They keep being fetched,
 * which means a retirement being undone is picked up by the next refresh instead of
 * leaving a target frozen in the log and reported stale forever.
 */
export function hidden(
  config: Config,
  snapshot: { ecosystem: Ecosystem; metrics: Record<string, unknown> },
): boolean {
  if (snapshot.ecosystem === 'npm') {
    return !config.includeDeprecated && snapshot.metrics.deprecated === 'yes'
  }
  if (snapshot.ecosystem !== 'github') return false
  if (!config.includeArchived && snapshot.metrics.archived === 'yes') return true
  if (!config.includeForks && snapshot.metrics.fork === 'yes') return true
  return false
}

export function ttlMs(config: Config, key: keyof Config['ttl']): number {
  return parseDuration(config.ttl[key])
}

export function deltaWindowMs(config: Config, ecosystem: Ecosystem): number {
  return parseDuration(config.deltaWindow[ecosystem])
}
