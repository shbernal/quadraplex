import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './paths.ts'
import { deltaWindowMs, ttlMs, type Config } from './config.ts'
import { computeDeltas } from './deltas.ts'
import {
  SCHEMA_VERSION,
  type Curve,
  type SeriesPoint,
  type Snapshot,
  type State,
  type Target,
} from './types.ts'

function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

function writeJson(file: string, value: unknown): void {
  ensureDir(file)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** Append-only history. The one file in the data directory the network cannot rebuild. */
export function appendSnapshots(snapshots: Snapshot[]): void {
  if (snapshots.length === 0) return
  ensureDir(paths.snapshots)
  appendFileSync(paths.snapshots, snapshots.map((s) => `${JSON.stringify(s)}\n`).join(''))
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
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    out.push(JSON.parse(line) as Snapshot)
  }
  return out
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

export function toTarget(
  snapshot: Snapshot,
  history: Snapshot[],
  config: Config,
  now: number,
): Target {
  const { deltas, deltaBaselineAt } = computeDeltas(
    snapshot,
    history,
    deltaWindowMs(config, snapshot.ecosystem),
  )
  const target: Target = {
    ...snapshot,
    deltas,
    stale: now - Date.parse(snapshot.fetchedAt) > ttlMs(config, snapshot.ecosystem),
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
    if (config.exclude.includes(latest.id)) continue
    targets.push(toTarget(latest, history, config, now))
  }
  targets.sort((a, b) => a.id.localeCompare(b.id))
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(now).toISOString(), targets }
}

export function writeState(state: State): void {
  writeJson(paths.state, state)
}

export function readState(): State | null {
  const state = readJson<State | null>(paths.state, null)
  return state
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

export function readCurve(id: string): Curve | null {
  return readJson<Curve | null>(paths.curve(id), null)
}

export function writeCurve(curve: Curve): void {
  writeJson(paths.curve(curve.id), curve)
}
