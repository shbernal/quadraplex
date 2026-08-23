import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './paths.ts'
import { deltaWindowMs, hidden, ttlMs, type Config } from './config.ts'
import { computeDeltas } from './deltas.ts'
import {
  SCHEMA_VERSION,
  type Curve,
  type Releases,
  type SeriesPoint,
  type Skills,
  type Snapshot,
  type State,
  type Target,
} from './types.ts'

function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}

/**
 * Every JSON file read here is derived or refetchable, so a damaged one is treated like a
 * missing one: it costs requests, never a failed command.
 */
function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (error) {
    if (error instanceof SyntaxError) return fallback
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

/** Written beside the target and renamed over it, so no reader ever sees half a file. */
function writeJson(file: string, value: unknown): void {
  ensureDir(file)
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, file)
}

/** Whether the file exists and its last byte is not a newline, i.e. a torn final line. */
function endsTorn(file: string): boolean {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return false
  }
  if (size === 0) return false
  const fd = openSync(file, 'r')
  try {
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } finally {
    closeSync(fd)
  }
}

/** Append-only history. The one file in the data directory the network cannot rebuild. */
export function appendSnapshots(snapshots: Snapshot[]): void {
  if (snapshots.length === 0) return
  ensureDir(paths.snapshots)
  // A write interrupted mid-line must not merge with the next record into a line that
  // parses as a wrong snapshot. It stays its own line and is skipped on read.
  const lead = endsTorn(paths.snapshots) ? '\n' : ''
  appendFileSync(paths.snapshots, lead + snapshots.map((s) => `${JSON.stringify(s)}\n`).join(''))
}

export function readSnapshots(): Snapshot[] {
  let text: string
  try {
    text = readFileSync(paths.snapshots, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: Snapshot[] = []
  let damaged = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Snapshot)
    } catch {
      damaged++
    }
  }
  if (damaged > 0) warnDamaged(damaged)
  return out
}

let warned = false

/** Said once per process on stderr, so `--json` stdout stays clean and the TUI is not flooded. */
function warnDamaged(count: number): void {
  if (warned) return
  warned = true
  process.stderr.write(
    `quadraplex: skipped ${count} unreadable line${count === 1 ? '' : 's'} in ${paths.snapshots}\n`,
  )
}

export function groupById(snapshots: Snapshot[]): Map<string, Snapshot[]> {
  const byId = new Map<string, Snapshot[]>()
  for (const snapshot of snapshots) {
    const list = byId.get(snapshot.id)
    if (list) list.push(snapshot)
    else byId.set(snapshot.id, [snapshot])
  }
  for (const list of byId.values()) {
    list.sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt))
  }
  return byId
}

/** An unreadable timestamp is expired: a damaged record is the one a reader must see flagged. */
export function expired(at: string, ttl: number, now: number): boolean {
  const age = now - Date.parse(at)
  return Number.isNaN(age) || age > ttl
}

function toTarget(snapshot: Snapshot, history: Snapshot[], config: Config, now: number): Target {
  const { deltas, deltaBaselineAt } = computeDeltas(
    snapshot,
    history,
    deltaWindowMs(config, snapshot.ecosystem),
  )
  const target: Target = {
    ...snapshot,
    deltas,
    stale: expired(snapshot.fetchedAt, ttlMs(config, snapshot.ecosystem), now),
  }
  if (deltaBaselineAt) target.deltaBaselineAt = deltaBaselineAt
  return target
}

/**
 * state.json is derived and rewritten wholesale. snapshots.jsonl is the source of truth,
 * so this must be reproducible from the log alone at any time.
 */
export function deriveState(config: Config, now = Date.now()): State {
  const byId = groupById(readSnapshots())
  const targets: Target[] = []
  for (const history of byId.values()) {
    const latest = history.at(-1)!
    if (latest.retired || config.exclude.includes(latest.id)) continue
    if (hidden(config, latest)) continue
    targets.push(toTarget(latest, history, config, now))
  }
  targets.sort((a, b) => a.id.localeCompare(b.id))
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(now).toISOString(), targets }
}

function writeState(state: State): void {
  writeJson(paths.state, state)
}

/**
 * Rebuilds state.json from history and returns it. Called after every refresh.
 *
 * Readers never load this file. `stale` is a verdict about the current clock, and a
 * cached verdict would report a day-old store as fresh forever. The file exists so an
 * agent can read the whole portfolio without starting a process.
 */
export function rebuildState(config: Config, now = Date.now()): State {
  const state = deriveState(config, now)
  writeState(state)
  return state
}

/** The read surface every command shares, always recomputed against the current clock. */
export function loadState(config: Config): State {
  return deriveState(config)
}

export type Cache = Record<string, { etag?: string; lastModified?: string; fetchedAt: string }>

export function readCache(): Cache {
  return readJson<Cache>(paths.cache, {})
}

export function writeCache(cache: Cache): void {
  writeJson(paths.cache, cache)
}

export function readSeries(id: string): SeriesPoint[] {
  return readJson<SeriesPoint[]>(paths.series(id), [])
}

export function writeSeries(id: string, points: SeriesPoint[]): void {
  writeJson(paths.series(id), points)
}

export function readDetail(id: string): unknown {
  return readJson<unknown>(paths.detail(id), null)
}

export function writeDetail(id: string, detail: unknown): void {
  writeJson(paths.detail(id), detail)
}

export function readCurve(id: string): Curve | null {
  return readJson<Curve | null>(paths.curve(id), null)
}

export function writeCurve(curve: Curve): void {
  writeJson(paths.curve(curve.id), curve)
}

export function readReleases(id: string): Releases | null {
  return readJson<Releases | null>(paths.releases(id), null)
}

export function writeReleases(releases: Releases): void {
  writeJson(paths.releases(releases.id), releases)
}

export function readSkills(id: string): Skills | null {
  return readJson<Skills | null>(paths.skills(id), null)
}

export function writeSkills(skills: Skills): void {
  writeJson(paths.skills(skills.id), skills)
}
