import { UsageError } from '../core/args.ts'

/**
 * The single enforcement point for "freshness needs a target". An agent cannot express
 * "refetch my portfolio" through the JSON surface because no command accepts that
 * combination, and this is where that stays true.
 */
export function rejectUnscopedFresh(command: string, flags: Record<string, unknown>): void {
  if (!flags.fresh) return
  throw new UsageError(
    `${command} reads the cache and never fetches, so --fresh has no meaning here.\n` +
      `Run "qplex refresh" to update everything, or pass --fresh to a single target such as "qplex npm <pkg> --fresh".`,
  )
}
