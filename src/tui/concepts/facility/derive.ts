import { loadConfig, ttlMs } from '../../../core/config.ts'
import { compactNumber } from '../../../core/format.ts'
import type { Ecosystem, Target } from '../../../core/types.ts'
import type { Project } from '../../model.ts'

/**
 * Which way the headline moved. `new` is a reading with no baseline yet, `none` is a
 * reading that cannot move at all (a Chrome bucket, a listing with no count).
 */
export type Signal = 'up' | 'down' | 'flat' | 'new' | 'none'

/** Portfolio-relative size of a move, 0 for no move, 3 for the wall's biggest. */
export type Intensity = 0 | 1 | 2 | 3

export type Headline = {
  text: string
  unit: string
  /** undefined: this reading never carries a delta. null: unknown, rendered "new". */
  delta: number | null | undefined
}

export type Tile = {
  project: Project
  name: string
  headline: Headline | null
  signal: Signal
  intensity: Intensity
  /** Stars gained since the baseline, the rarest and loudest news a repo has. */
  starred: number
  versions: boolean
  unreleased: boolean
  /** Some reading on this tile is past its TTL. */
  stale: boolean
  /** Missed the wall's latest refresh, which is the only staleness worth a mark per tile. */
  lagging: boolean
  errors: string[]
  oldest: string
  stores: string
}

/** One letter per store, in a fixed order so the column reads the same on every tile. */
export const STORE_LETTERS: [Ecosystem, string][] = [
  ['npm', 'n'],
  ['pypi', 'p'],
  ['github', 'G'],
  ['amo', 'A'],
  ['cws', 'C'],
]

/**
 * The reading that leads a tile is the one that can carry a delta. An extension's Firefox
 * user count can, Google's install bucket cannot, so the bucket is only the fallback and is
 * marked with a tilde wherever it appears.
 */
function headline(project: Project): Headline | null {
  if (project.kind === 'extension') {
    const amo = project.targets.find(
      (t) => t.ecosystem === 'amo' && typeof t.metrics.users === 'number',
    )
    if (amo) {
      return {
        text: compactNumber(amo.metrics.users as number),
        unit: 'u',
        delta: amo.deltas ? (amo.deltas.users ?? null) : null,
      }
    }
    if (project.reach) return { text: `${project.reach.label}~`, unit: 'u', delta: undefined }
  }
  if (project.downloads) {
    return {
      text: compactNumber(project.downloads.value),
      unit: '/wk',
      delta: project.downloads.delta,
    }
  }
  if (project.stars)
    return { text: String(project.stars.value), unit: '★', delta: project.stars.delta }
  return null
}

function signal(delta: number | null | undefined): Signal {
  if (delta === undefined) return 'none'
  if (delta === null) return 'new'
  if (delta === 0) return 'flat'
  return delta > 0 ? 'up' : 'down'
}

const newestOf = (targets: Target[]) =>
  targets.reduce((at, t) => (t.fetchedAt > at ? t.fetchedAt : at), '')
const oldestOf = (targets: Target[]) =>
  targets.reduce((at, t) => (!at || t.fetchedAt < at ? t.fetchedAt : at), '')

/** A target that sat out the latest refresh by more than this has been left behind. */
const LAG_MS = 60 * 60 * 1000

export type Wall = {
  tiles: Tile[]
  /** When the wall was last read from the network, the freshest fetch on it. */
  readAt: string
  /** The baseline most deltas compare against, stated once for the whole wall. */
  baselineAt: string | null
  /** Ecosystems with a target past TTL, with how many. */
  pastTtl: { ecosystem: Ecosystem; count: number; ttl: string }[]
  ttl: Record<Ecosystem, number>
}

export function buildWall(projects: Project[]): Wall {
  const config = loadConfig()
  const all = projects.flatMap((p) => p.targets)
  const readAt = newestOf(all)
  const lagBefore = Date.parse(readAt) - LAG_MS

  const tiles = projects.map((project): Tile => {
    const head = headline(project)
    const starred = project.stars?.delta ?? 0
    return {
      project,
      name: project.name,
      headline: head,
      signal: signal(head?.delta),
      intensity: 0,
      starred: starred > 0 ? starred : 0,
      versions: Boolean(project.drift.versions),
      unreleased: Boolean(project.drift.unreleased),
      stale: project.stale,
      lagging: project.targets.some((t) => Date.parse(t.fetchedAt) < lagBefore),
      errors: project.targets.flatMap((t) => t.errors ?? []),
      oldest: oldestOf(project.targets),
      stores: STORE_LETTERS.filter(([eco]) => project.targets.some((t) => t.ecosystem === eco))
        .map(([, letter]) => letter)
        .join(''),
    }
  })

  // Size is relative to the wall, on a log scale, because one package's +158 should not
  // flatten every other move into the same faint shade.
  const sizes = tiles.map((t) =>
    typeof t.headline?.delta === 'number' ? Math.log1p(Math.abs(t.headline.delta)) : 0,
  )
  const max = Math.max(0, ...sizes)
  tiles.forEach((tile, i) => {
    const size = sizes[i]!
    if (size === 0 || max === 0) return
    tile.intensity = Math.max(1, Math.min(3, Math.ceil((size / max) * 3))) as Intensity
  })

  const baselines = new Map<string, number>()
  for (const t of all) {
    if (!t.deltaBaselineAt) continue
    const day = t.deltaBaselineAt.slice(0, 10)
    baselines.set(day, (baselines.get(day) ?? 0) + 1)
  }
  const common = [...baselines.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0]
  const baselineAt = common
    ? (all.find((t) => t.deltaBaselineAt?.startsWith(common))!.deltaBaselineAt ?? null)
    : null

  const counts = new Map<Ecosystem, number>()
  for (const t of all) if (t.stale) counts.set(t.ecosystem, (counts.get(t.ecosystem) ?? 0) + 1)
  const pastTtl = [...counts.entries()].map(([ecosystem, count]) => ({
    ecosystem,
    count,
    ttl: config.ttl[ecosystem],
  }))

  const ttl = Object.fromEntries(STORE_LETTERS.map(([eco]) => [eco, ttlMs(config, eco)])) as Record<
    Ecosystem,
    number
  >

  return { tiles, readAt, baselineAt, pastTtl, ttl }
}

/** Stable by name, so a project lives at one place on the wall and the eye learns where. */
export function wallOrder(tiles: Tile[]): Tile[] {
  return tiles.toSorted((a, b) => a.name.localeCompare(b.name))
}

/** Biggest movers first, falls and rises interleaved by size, quiet tiles last. */
export function heatOrder(tiles: Tile[]): Tile[] {
  const weight = (t: Tile) => {
    const d = t.headline?.delta
    return (
      (typeof d === 'number' ? Math.abs(d) : 0) + t.starred * 1000 + (t.signal === 'new' ? 0.5 : 0)
    )
  }
  return tiles.toSorted((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name))
}

export const LIGHTS = ['all', 'moved', 'drift', 'stale'] as const
export type Light = (typeof LIGHTS)[number]

/** Which tiles stay lit under a highlight. The rest dim in place rather than vanish. */
export function lit(tile: Tile, light: Light): boolean {
  switch (light) {
    case 'moved':
      return (
        tile.signal === 'up' || tile.signal === 'down' || tile.signal === 'new' || tile.starred > 0
      )
    case 'drift':
      return tile.versions || tile.unreleased
    case 'stale':
      return tile.lagging || tile.errors.length > 0 || tile.stale
    default:
      return true
  }
}
