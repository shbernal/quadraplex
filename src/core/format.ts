export function compactNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 10_000) return `${(value / 1000).toFixed(0)}k`
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** null is unknown, not zero, so it renders as "new" everywhere it appears. */
export function formatDelta(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) return 'new'
  if (delta === 0) return '0'
  return `${delta > 0 ? '+' : '-'}${compactNumber(Math.abs(delta))}`
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function since(iso: string | undefined): string {
  return iso ? ` since ${formatDate(iso)}` : ''
}

/** How much later one moment is than another, in the units relativeAge already uses. */
export function span(fromIso: string, toIso: string): string {
  const hours = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function relativeAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function table(rows: string[][], align: ('left' | 'right')[] = []): string {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          align[i] === 'right' ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}
