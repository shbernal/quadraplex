const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/** Parses "24h", "30d", "90m". Throws on anything else so a bad config fails loudly. */
export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(value.trim())
  const unit = match ? UNITS[match[2]!] : undefined
  if (!match || unit === undefined) {
    throw new Error(`invalid duration "${value}", expected a number followed by s, m, h, d or w`)
  }
  return Number(match[1]) * unit
}
