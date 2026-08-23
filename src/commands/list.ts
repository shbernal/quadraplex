import { UsageError } from '../core/args.ts'
import { configured, loadConfig } from '../core/config.ts'
import { loadState } from '../core/store.ts'
import { formatDelta, relativeAge, since, table } from '../core/format.ts'
import {
  ECOSYSTEM_CHOICES,
  ecosystemNamed,
  HEADLINE_METRIC,
  SCHEMA_VERSION,
  type Ecosystem,
} from '../core/types.ts'

export type ListPayload = {
  schemaVersion: number
  generatedAt: string
  ecosystem: Ecosystem
  targets: {
    id: string
    name: string
    /** Present when the source publishes one, because a name is not always readable. */
    title?: string
    discovered: 'auto' | 'config'
    summary: string
    stale: boolean
    fetchedAt: string
  }[]
}

export function parseEcosystem(value: string | undefined): Ecosystem {
  const ecosystem = ecosystemNamed(value)
  if (ecosystem) return ecosystem
  throw new UsageError(`list needs an ecosystem, one of ${ECOSYSTEM_CHOICES}`)
}

export function listPayload(ecosystem: Ecosystem): ListPayload {
  const config = loadConfig()
  const state = loadState(config)
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: state.generatedAt,
    ecosystem,
    targets: state.targets
      .filter((t) => t.ecosystem === ecosystem)
      .map((t) => {
        const metric = HEADLINE_METRIC[t.ecosystem]
        const value = t.metrics[metric] ?? null
        const delta = t.deltas ? (t.deltas[metric] ?? null) : null
        // Only a number can carry a delta. See the same rule in the status table.
        const movement =
          typeof value === 'number' ? `, ${formatDelta(delta)}${since(t.deltaBaselineAt)}` : ''
        const entry: ListPayload['targets'][number] = {
          id: t.id,
          name: t.name,
          discovered: t.discovered,
          summary: `${metric} ${value ?? '-'}${movement}`,
          stale: t.stale,
          fetchedAt: t.fetchedAt,
        }
        if (typeof t.metrics.title === 'string') entry.title = t.metrics.title
        return entry
      }),
  }
}

export function listTable(payload: ListPayload): string {
  if (payload.targets.length === 0) {
    if (!configured()) return 'no accounts are set up, run "qplex init"'
    return `no ${payload.ecosystem} targets in the store, run "qplex refresh --only ${payload.ecosystem}"`
  }
  // A Chrome extension id is not a name, so the column is kept and the title added next
  // to it rather than swapped in: the name is still what a targeted command takes.
  const titled = payload.targets.some((t) => t.title)
  return table(
    payload.targets.map((t) => [
      t.stale ? '!' : ' ',
      t.name,
      ...(titled ? [t.title ?? ''] : []),
      t.summary,
      t.discovered,
      relativeAge(t.fetchedAt),
    ]),
    ['left', 'left', 'left', 'left', 'left', 'right'],
  )
}
