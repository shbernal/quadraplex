import { UsageError } from '../core/args.ts'
import { loadConfig } from '../core/config.ts'
import { flushCache } from '../core/http.ts'
import { appendSnapshots, loadState, rebuildState, readSeries, writeSeries } from '../core/store.ts'
import { formatDelta, relativeAge, since, table } from '../core/format.ts'
import {
  SCHEMA_VERSION,
  targetId,
  type Ecosystem,
  type SeriesPoint,
  type Target,
} from '../core/types.ts'
import { sourceFor } from '../sources/registry.ts'

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
  amo: 'amo',
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
    const fetched = await source.fetch({ name, discovered: 'config' }, config)
    const overrides = config.links[fetched.snapshot.id]
    if (overrides) fetched.snapshot.links = overrides
    appendSnapshots([fetched.snapshot])
    if (fetched.series?.length) writeSeries(fetched.snapshot.id, fetched.series)
    flushCache()
    const state = rebuildState(config)
    const target = state.targets.find((t) => t.id === id)!
    const payload: TargetPayload = { schemaVersion: SCHEMA_VERSION, target, series: readSeries(id) }
    if (fetched.detail) payload.detail = fetched.detail
    return payload
  }

  const target = loadState(config).targets.find((t) => t.id === id)
  if (!target) {
    throw new UsageError(
      `${id} is not in the store. Run "qplex refresh" first, or "qplex ${ecosystem === 'github' ? 'gh' : ecosystem} ${name} --fresh" to fetch just this one.`,
    )
  }
  return { schemaVersion: SCHEMA_VERSION, target, series: readSeries(id) }
}

export function targetText(payload: TargetPayload): string {
  const { target } = payload
  const rows: string[][] = [['', '', '']]
  rows.length = 0
  for (const [key, value] of Object.entries(target.metrics)) {
    const delta = target.deltas ? (target.deltas[key] ?? null) : null
    rows.push([
      key,
      value === null ? '-' : String(value),
      typeof value === 'number' ? formatDelta(delta) + since(target.deltaBaselineAt) : '',
    ])
  }
  const header = `${target.id}${target.stale ? '  (stale)' : ''}\n${target.url}\nfetched ${relativeAge(target.fetchedAt)}`
  const links = target.links.length ? `\nlinked: ${target.links.join(', ')}` : ''
  const errors = target.errors?.length ? `\nerrors: ${target.errors.join('; ')}` : ''
  return `${header}${links}${errors}\n\n${table(rows, ['left', 'right', 'right'])}`
}
