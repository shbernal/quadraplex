import { UsageError } from '../core/args.ts'
import { configuredEcosystems, loadConfig, type Config } from '../core/config.ts'
import { describe } from '../core/errors.ts'
import { flushCache, mapLimit } from '../core/http.ts'
import {
  appendSnapshots,
  groupById,
  readSnapshots,
  rebuildState,
  writeDetail,
  writeReleases,
  writeSkills,
  writeSeries,
} from '../core/store.ts'
import {
  ECOSYSTEM_CHOICES,
  ecosystemNamed,
  ECOSYSTEMS,
  parseTargetId,
  targetId,
  type Ecosystem,
  type Snapshot,
} from '../core/types.ts'
import { sources, sourceFor } from '../sources/all.ts'
import { Gone, PartialDiscovery, type Descriptor } from '../sources/types.ts'

const CONCURRENCY = 3

/**
 * A ceiling on the whole run. Past it no new request starts: targets not yet fetched carry
 * forward as failed, and ecosystems still to start skip discovery for the targets already known.
 * Requests in flight still finish within their own per-attempt timeout.
 */
const DEADLINE_MS = 5 * 60_000
const DEADLINE_ERROR = 'refresh deadline reached, not fetched'

/**
 * An ecosystem's 503 or a rate limit is a Tuesday, so a failed target records the attempt
 * rather than disappearing. It keeps its last values and its last real fetchedAt, which
 * is what ages it into stale, and carries attemptedAt plus the error alongside.
 */
function carryForward(previous: Snapshot, message: string): Snapshot {
  return { ...previous, attemptedAt: new Date().toISOString(), errors: [message] }
}

/** The last values seen, kept in the log, with the reason the target left the portfolio. */
function retire(previous: Snapshot, reason: string): Snapshot {
  const { attemptedAt: _attempted, errors: _errors, ...rest } = previous
  return { ...rest, retired: { at: new Date().toISOString(), reason } }
}

export type RefreshReport = {
  ecosystems: Ecosystem[]
  ok: number
  failed: { id: string; error: string }[]
  /** Ecosystems whose discovery threw. Their already known targets were fetched instead. */
  discoveryFailed: { ecosystem: Ecosystem; error: string }[]
  /** Targets this refresh found deleted, unpublished, private or no longer the account's. */
  retired: { id: string; reason: string }[]
}

export function parseOnly(value: unknown): Ecosystem[] {
  if (value === undefined) return ECOSYSTEMS.filter((e) => sources[e])
  const ecosystem = ecosystemNamed(value)
  if (!ecosystem || !sources[ecosystem]) {
    throw new UsageError(`--only takes one of ${ECOSYSTEM_CHOICES}`)
  }
  return [ecosystem]
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

export async function refresh(
  options: { only?: unknown; deadlineMs?: number } = {},
): Promise<RefreshReport> {
  const config = loadConfig()
  if (configuredEcosystems(config).size === 0) {
    throw new UsageError('no accounts to refresh. Run "qplex init" to set them up.')
  }
  const ecosystems = parseOnly(options.only)
  const deadline = Date.now() + (options.deadlineMs ?? DEADLINE_MS)

  const previous = groupById(readSnapshots())
  const report: RefreshReport = {
    ecosystems,
    ok: 0,
    failed: [],
    discoveryFailed: [],
    retired: [],
  }

  try {
    // Each ecosystem talks to its own host, so they run side by side. allSettled, so the
    // state is never rebuilt while another ecosystem is still writing.
    const settled = await Promise.allSettled(
      ecosystems.map((e) => refreshEcosystem(e, config, previous, report, deadline)),
    )
    const rejected = settled.find((s) => s.status === 'rejected')
    if (rejected) throw rejected.reason
  } finally {
    rebuildState(config)
  }
  return report
}

/**
 * Persists before returning, so a failure or an interrupt later in the run keeps what this
 * ecosystem already paid for.
 */
async function refreshEcosystem(
  ecosystem: Ecosystem,
  config: Config,
  previous: Map<string, Snapshot[]>,
  report: RefreshReport,
  deadline: number,
): Promise<void> {
  const source = sourceFor(ecosystem)
  const snapshots: Snapshot[] = []
  const last = (name: string) => previous.get(targetId(ecosystem, name))?.at(-1)
  const excluded = (name: string) => config.exclude.includes(targetId(ecosystem, name))
  const known = (): Descriptor[] =>
    [...previous.values()]
      .map((history) => history.at(-1)!)
      .filter((latest) => latest.ecosystem === ecosystem && !latest.retired)
      .map((latest) => ({ name: latest.name, discovered: latest.discovered }))
  const retireOne = (name: string, reason: string) => {
    snapshots.push(retire(last(name)!, reason))
    report.retired.push({ id: targetId(ecosystem, name), reason })
  }

  let discovered: Descriptor[]
  let complete = false
  if (Date.now() >= deadline) {
    discovered = known()
  } else {
    try {
      discovered = await source.discover(config)
      complete = source.roster
    } catch (error) {
      // One 404 or rate limit must not cost the ecosystem its refresh. The targets the store
      // already knows are still worth fetching, and those that fail carry forward as usual.
      report.discoveryFailed.push({ ecosystem, error: describe(error) })
      const found = error instanceof PartialDiscovery ? error.found : []
      discovered = dedupe([...found, ...known()])
    }
  }
  const named = [...discovered, ...configTargets(config, ecosystem)]
  const listed = new Set(named.map((descriptor) => descriptor.name))
  const missing = known().filter((d) => !listed.has(d.name) && !excluded(d.name))

  // A roster that answered in full is the portfolio, so absence from it settles the
  // matter. A search can miss, so a target missing from one is fetched and must be
  // answered as gone before it is retired.
  const account = config.accounts[ecosystem]
  if (complete) for (const d of missing) retireOne(d.name, `no longer listed for ${account}`)
  const descriptors = dedupe(complete ? named : [...named, ...missing]).filter(
    (descriptor) => !excluded(descriptor.name),
  )

  try {
    await mapLimit(descriptors, CONCURRENCY, async (descriptor) => {
      const id = targetId(ecosystem, descriptor.name)
      try {
        if (Date.now() >= deadline) throw new Error(DEADLINE_ERROR)
        const fetched = await source.fetch(descriptor, config, previous.get(id)?.at(-1))
        const snapshot = fetched.snapshot
        const overrides = config.links[snapshot.id]
        if (overrides) snapshot.links = overrides
        snapshots.push(snapshot)
        if (fetched.series?.length) writeSeries(snapshot.id, fetched.series)
        if (fetched.detail) writeDetail(snapshot.id, fetched.detail)
        if (fetched.releases) writeReleases(fetched.releases)
        if (fetched.skills) writeSkills(fetched.skills)
        report.ok++
      } catch (error) {
        const message = describe(error)
        const before = last(descriptor.name)
        if (error instanceof Gone && before) {
          // An `include` entry keeps being asked, and a target already retired is not
          // retired again.
          if (!before.retired) retireOne(descriptor.name, error.message)
          return
        }
        report.failed.push({ id, error: message })
        if (before) snapshots.push(carryForward(before, message))
      }
    })
  } finally {
    appendSnapshots(snapshots)
    flushCache()
  }
}

export function refreshSummary(report: RefreshReport): string {
  const lines = [
    `refreshed ${report.ok} target${report.ok === 1 ? '' : 's'} across ${report.ecosystems.join(', ')}`,
  ]
  for (const failure of report.discoveryFailed) {
    lines.push(`  discovery failed for ${failure.ecosystem}, known targets only: ${failure.error}`)
  }
  for (const failure of report.failed) lines.push(`  failed ${failure.id}: ${failure.error}`)
  for (const gone of report.retired) lines.push(`  retired ${gone.id}: ${gone.reason}`)
  return lines.join('\n')
}
