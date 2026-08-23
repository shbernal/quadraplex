import { UsageError } from '../core/args.ts'
import { loadConfig, type Config } from '../core/config.ts'
import { flushCache, mapLimit } from '../core/http.ts'
import {
  appendSnapshots,
  groupById,
  readSnapshots,
  rebuildState,
  writeSeries,
} from '../core/store.ts'
import {
  ECOSYSTEMS,
  parseTargetId,
  targetId,
  type Ecosystem,
  type Snapshot,
} from '../core/types.ts'
import { sources, sourceFor } from '../sources/registry.ts'
import type { Descriptor } from '../sources/types.ts'

const CONCURRENCY = 3

/**
 * A registry 503 or a rate limit is a Tuesday, so a failed target records the attempt
 * rather than disappearing. It keeps its last values and its last real fetchedAt, which
 * is what ages it into stale, and carries attemptedAt plus the error alongside.
 */
function carryForward(previous: Snapshot, message: string): Snapshot {
  return { ...previous, attemptedAt: new Date().toISOString(), errors: [message] }
}

export type RefreshReport = {
  ecosystems: Ecosystem[]
  ok: number
  failed: { id: string; error: string }[]
}

export function parseOnly(value: unknown): Ecosystem[] {
  if (value === undefined) return ECOSYSTEMS.filter((e) => sources[e])
  const name = value === 'gh' ? 'github' : value
  if (typeof name !== 'string' || !(ECOSYSTEMS as string[]).includes(name)) {
    throw new UsageError(`--only takes one of ${ECOSYSTEMS.join(', ')}`)
  }
  return [name as Ecosystem]
}

/** Config `include` entries are targets discovery cannot or did not find. */
function configTargets(config: Config, ecosystem: Ecosystem): Descriptor[] {
  return config.include
    .map(parseTargetId)
    .filter((parsed) => parsed?.ecosystem === ecosystem)
    .map((parsed) => ({ name: parsed!.name, discovered: 'config' as const }))
}

function dedupe(descriptors: Descriptor[]): Descriptor[] {
  const seen = new Map<string, Descriptor>()
  for (const descriptor of descriptors) {
    if (!seen.has(descriptor.name)) seen.set(descriptor.name, descriptor)
  }
  return [...seen.values()]
}

export async function refresh(options: { only?: unknown } = {}): Promise<RefreshReport> {
  const config = loadConfig()
  const ecosystems = parseOnly(options.only)

  const previous = groupById(readSnapshots())
  const report: RefreshReport = { ecosystems, ok: 0, failed: [] }
  const snapshots: Snapshot[] = []

  for (const ecosystem of ecosystems) {
    const source = sourceFor(ecosystem)
    const descriptors = dedupe([
      ...(await source.discover(config)),
      ...configTargets(config, ecosystem),
    ]).filter((descriptor) => !config.exclude.includes(targetId(ecosystem, descriptor.name)))

    await mapLimit(descriptors, CONCURRENCY, async (descriptor) => {
      const id = targetId(ecosystem, descriptor.name)
      try {
        const fetched = await source.fetch(descriptor, config)
        const snapshot = fetched.snapshot
        const overrides = config.links[snapshot.id]
        if (overrides) snapshot.links = overrides
        snapshots.push(snapshot)
        if (fetched.series?.length) writeSeries(snapshot.id, fetched.series)
        report.ok++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        report.failed.push({ id, error: message })
        const last = previous.get(id)?.at(-1)
        if (last) snapshots.push(carryForward(last, message))
      }
    })
  }

  appendSnapshots(snapshots)
  flushCache()
  rebuildState(config)
  return report
}

export function refreshSummary(report: RefreshReport): string {
  const lines = [
    `refreshed ${report.ok} target${report.ok === 1 ? '' : 's'} across ${report.ecosystems.join(', ')}`,
  ]
  for (const failure of report.failed) lines.push(`  failed ${failure.id}: ${failure.error}`)
  return lines.join('\n')
}
