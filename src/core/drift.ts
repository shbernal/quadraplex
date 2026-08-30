import { ECOSYSTEMS, type Ecosystem, type Target } from './types.ts'

/** A day, the window npm downloads and the default deltas already use. */
const UNRELEASED_MS = 24 * 60 * 60 * 1000

export type Drift = {
  /** The version every store agrees on. Null when they disagree or none publishes one. */
  version: string | null
  /** Set only when two stores publish different versions of the same project. */
  versions: { ecosystem: Ecosystem; version: string }[] | null
  /** Set only when the repo was pushed more than a day after the newest release. */
  unreleased: { pushedAt: string; publishedAt: string } | null
}

function newest(targets: Target[], key: string): string | undefined {
  return targets
    .map((target) => target.metrics[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .toSorted()
    .at(-1)
}

/**
 * One version per store. A store whose own targets disagree contributes none: a monorepo
 * publishing packages on their own cadence is normal, and picking one of its versions to
 * compare against Chrome would report that cadence as a defect.
 */
function published(targets: Target[]): { ecosystem: Ecosystem; version: string }[] {
  const out: { ecosystem: Ecosystem; version: string }[] = []
  for (const ecosystem of ECOSYSTEMS) {
    if (ecosystem === 'github') continue
    const versions = new Set(
      targets
        .filter((target) => target.ecosystem === ecosystem)
        .map((target) => target.metrics.version)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    )
    const only = [...versions]
    if (only.length === 1) out.push({ ecosystem, version: only[0]! })
  }
  return out
}

/**
 * What a publisher gets wrong that no single store can tell them: shipping one store and
 * forgetting the other, and leaving work on the default branch that was never released.
 * Both readings come from metrics already in the store, so neither costs a request.
 */
export function computeDrift(targets: Target[]): Drift {
  const versions = published(targets)
  const distinct = new Set(versions.map((entry) => entry.version))
  const drift: Drift = {
    version: distinct.size === 1 ? [...distinct][0]! : null,
    versions: distinct.size > 1 ? versions : null,
    unreleased: null,
  }

  const pushedAt = newest(
    targets.filter((target) => target.ecosystem === 'github'),
    'lastPush',
  )
  const publishedAt = newest(targets, 'lastPublish')
  if (pushedAt && publishedAt && Date.parse(pushedAt) - Date.parse(publishedAt) > UNRELEASED_MS) {
    drift.unreleased = { pushedAt, publishedAt }
  }
  return drift
}
