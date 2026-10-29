import { UsageError } from '../core/args.ts'
import { loadConfig, type Config } from '../core/config.ts'
import { flushCache } from '../core/http.ts'
import {
  appendSnapshots,
  groupById,
  loadState,
  readSeries,
  readSnapshots,
  rebuildState,
  writeDetail,
  writeReleases,
  writeSkills,
  writeSeries,
} from '../core/store.ts'
import { formatDelta, metricLabel, metricText, relativeAge, since, table } from '../core/format.ts'
import {
  SCHEMA_VERSION,
  targetId,
  type Ecosystem,
  type SeriesPoint,
  type Snapshot,
  type Target,
} from '../core/types.ts'
import { sourceFor } from '../sources/all.ts'

export type TargetPayload = {
  schemaVersion: number
  target: Target
  series: SeriesPoint[]
  detail?: Record<string, unknown>
}

export const TARGET_COMMANDS: Record<string, Ecosystem> = {
  npm: 'npm',
  pypi: 'pypi',
  gh: 'github',
  github: 'github',
  ghcr: 'ghcr',
  amo: 'amo',
  cws: 'cws',
  clawhub: 'clawhub',
  dockerhub: 'dockerhub',
  docker: 'dockerhub',
  rubygems: 'rubygems',
  gem: 'rubygems',
  jsr: 'jsr',
  vscode: 'vscode',
  openvsx: 'openvsx',
  aur: 'aur',
}

/**
 * The only read path allowed to fetch, and only for the one target named on the command
 * line. A targeted refetch still appends a snapshot, so drilling down feeds history.
 */
export async function targetPayload(
  ecosystem: Ecosystem,
  name: string | undefined,
  fresh: boolean,
): Promise<TargetPayload> {
  if (!name) throw new UsageError(`${ecosystem} needs a target, for example "qplex npm charcheck"`)
  const config = loadConfig()
  const id = targetId(ecosystem, name)

  if (fresh) {
    const source = sourceFor(ecosystem)
    const previous = groupById(readSnapshots()).get(id)?.at(-1)
    // A target refetched by hand keeps the provenance it already has.
    const discovered = previous?.discovered ?? 'config'
    const fetched = await source.fetch({ name, discovered, fresh: true }, config, previous)
    const snapshot = fetched.snapshot
    const overrides = config.links[snapshot.id]
    if (overrides) snapshot.links = overrides
    appendSnapshots([snapshot])
    if (fetched.series?.length) writeSeries(snapshot.id, fetched.series)
    if (fetched.detail) writeDetail(snapshot.id, fetched.detail)
    if (fetched.releases) writeReleases(fetched.releases)
    if (fetched.skills) writeSkills(fetched.skills)
    flushCache()
    // The source names the snapshot, and AMO answers an old slug with the canonical one.
    const target = rebuildState(config).targets.find((t) => t.id === snapshot.id)
    if (!target) throw new UsageError(droppedReason(config, snapshot))
    const payload: TargetPayload = {
      schemaVersion: SCHEMA_VERSION,
      target,
      series: readSeries(snapshot.id),
    }
    if (fetched.detail) payload.detail = fetched.detail
    return payload
  }

  const target = loadState(config).targets.find((t) => t.id === id)
  const retired = target ? undefined : groupById(readSnapshots()).get(id)?.at(-1)?.retired
  if (retired) {
    throw new UsageError(
      `${id} was retired ${retired.at.slice(0, 10)}: ${retired.reason}. Refresh brings it back if discovery finds it again.`,
    )
  }
  if (!target) {
    throw new UsageError(
      `${id} is not in the store. Run "qplex refresh" first, or "qplex ${ecosystem === 'github' ? 'gh' : ecosystem} ${name} --fresh" to fetch just this one.`,
    )
  }
  return { schemaVersion: SCHEMA_VERSION, target, series: readSeries(id) }
}

/** Why a snapshot that was just written is absent from the state built from it. */
function droppedReason(config: Config, snapshot: Snapshot): string {
  const why = config.exclude.includes(snapshot.id)
    ? 'it is listed in "exclude"'
    : snapshot.metrics.archived === 'yes'
      ? 'it is archived, see "includeArchived"'
      : snapshot.metrics.fork === 'yes'
        ? 'it is a fork, see "includeForks"'
        : 'it is deprecated, see "includeDeprecated"'
  return `${snapshot.id} was fetched and stored, but config hides it: ${why}.`
}

export function targetText(payload: TargetPayload): string {
  const { target } = payload
  const rows: string[][] = []
  for (const [key, value] of Object.entries(target.metrics)) {
    const delta = target.deltas ? (target.deltas[key] ?? null) : null
    rows.push([
      metricLabel(key),
      metricText(value),
      typeof value === 'number' ? formatDelta(delta) + since(target.deltaBaselineAt) : '',
    ])
  }
  const header = `${target.id}${target.stale ? '  (stale)' : ''}\n${target.url}\nfetched ${relativeAge(target.fetchedAt)}`
  const links = target.links.length ? `\nlinked: ${target.links.join(', ')}` : ''
  const errors = target.errors?.length ? `\nerrors: ${target.errors.join('; ')}` : ''
  return `${header}${links}${errors}\n\n${table(rows, ['left', 'right', 'right'])}`
}
