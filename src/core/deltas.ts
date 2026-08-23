import type { Snapshot } from './types.ts'

export type DeltaResult = {
  deltas: Record<string, number | null> | null
  deltaBaselineAt?: string
}

/**
 * Compares against the newest snapshot at least one window older than the current one,
 * not against the previous log line. Refresh spacing is arbitrary in a pull-only tool,
 * so a bare "previous line" delta would read as zero after two refreshes ten minutes
 * apart and as a three-week jump after a holiday, with nothing to tell them apart.
 *
 * Returns null when no snapshot predates the window. That means unknown, not zero.
 */
export function computeDeltas(
  current: Snapshot,
  history: Snapshot[],
  windowMs: number,
): DeltaResult {
  const cutoff = Date.parse(current.fetchedAt) - windowMs
  let baseline: Snapshot | undefined
  for (const snapshot of history) {
    if (snapshot === current) continue
    const at = Date.parse(snapshot.fetchedAt)
    if (at > cutoff) continue
    if (!baseline || at > Date.parse(baseline.fetchedAt)) baseline = snapshot
  }
  if (!baseline) return { deltas: null }

  const deltas: Record<string, number | null> = {}
  for (const [key, value] of Object.entries(current.metrics)) {
    const before = baseline.metrics[key]
    deltas[key] = typeof value === 'number' && typeof before === 'number' ? value - before : null
  }
  return { deltas, deltaBaselineAt: baseline.fetchedAt }
}
