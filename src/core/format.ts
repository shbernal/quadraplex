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
  // UTC throughout, because a date-only value like "2026-08-06" is midnight UTC and would
  // otherwise print as the fifth for every reader west of Greenwich.
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
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

/** Values a source publishes as an ISO date or timestamp, recognised by shape. */
const ISO = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-][\d:]+)?)?$/

const LABELS: Record<string, string> = {
  defaultBranch: 'default branch',
  downloadsDay: 'downloads, day',
  downloadsMonth: 'downloads, month',
  downloadsTotal: 'downloads, all time',
  downloadsWeek: 'downloads, week',
  lastPublish: 'last publish',
  lastPush: 'last push',
  offeredBy: 'offered by',
  openIssues: 'open issues',
  // open_issues_count includes pull requests, and the name says so wherever it is shown.
  openIssuesAndPRs: 'open issues + PRs',
  openPRs: 'open PRs',
  skillInstalls: 'skill installs',
  unreleasedCommits: 'commits since release',
}

export function metricLabel(key: string): string {
  return LABELS[key] ?? key
}

/**
 * A timestamp is the one metric value a reader cannot use as published. Everything else
 * is printed as the source gave it, including Google's "1,000", which is a label.
 */
export function metricText(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '-'
  if (typeof value !== 'string' || !ISO.test(value)) return String(value)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  const days = (Date.now() - at) / 86_400_000
  const stamped =
    new Date(at).getUTCFullYear() === new Date().getUTCFullYear()
      ? formatDate(value)
      : new Date(at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        })
  // Past a year the relative half stops helping: "Jun 22, 2025" places it, "434d ago"
  // only makes the reader do the arithmetic back.
  return days >= 0 && days <= 365 ? `${stamped}, ${relativeAge(value)}` : stamped
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
