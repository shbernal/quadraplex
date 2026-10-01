/** Display helpers for the concept. Every date is UTC, matching core's formatDate. */

export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text.padEnd(width)
  return `${text.slice(0, Math.max(width - 1, 0))}…`
}

export function clip(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(width - 1, 0))}…`
}

export function day(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function weekday(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
}

export function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16)
}

export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 0)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function span(fromIso: string, toIso: string): string {
  const hours = (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000
  if (hours < 48) return `${Math.round(hours)} hours`
  const days = hours / 24
  return `${days < 10 ? days.toFixed(1).replace(/\.0$/, '') : Math.round(days)} days`
}

/** Every UTC day from the one after `fromIso` through `toIso`, inclusive. */
export function daysBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = []
  const end = toIso.slice(0, 10)
  let t = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`) + 86_400_000
  for (let d = new Date(t).toISOString().slice(0, 10); d <= end;) {
    out.push(d)
    t += 86_400_000
    d = new Date(t).toISOString().slice(0, 10)
  }
  return out
}

/** Names in a line until the line runs out, then how many were left unsaid. */
export function nameList(names: string[], width: number): string {
  let out = ''
  for (const [i, name] of names.entries()) {
    const rest = names.length - i - 1
    const next = out ? `${out}, ${name}` : name
    const tail = rest > 0 ? ` +${rest}` : ''
    if (next.length + tail.length > width) return `${out} +${names.length - i}`
    out = next
  }
  return out
}
