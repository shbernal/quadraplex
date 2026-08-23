/** How many causes deep an error is followed. A wrapper and what it wraps is the usual case. */
const DEPTH = 3

function text(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as NodeJS.ErrnoException).code
  return code && !error.message.includes(code) ? `${error.message} (${code})` : error.message
}

/**
 * The message followed by its `cause` chain. "request failed" alone cannot tell offline
 * from DNS from TLS from a refused proxy, and the cause is what can.
 */
export function causeChain(error: unknown): string[] {
  const out = [text(error)]
  let at = error instanceof Error ? error.cause : undefined
  while (at !== undefined && out.length < DEPTH) {
    out.push(text(at))
    at = at instanceof Error ? at.cause : undefined
  }
  return out
}

/** The chain on one line, for a report entry that is shown as a single row. */
export function describe(error: unknown): string {
  return causeChain(error).join(': ')
}
