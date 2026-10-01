import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { compactNumber } from '../../../core/format.ts'
import { HEADLINE_METRIC, type Target } from '../../../core/types.ts'
import { theme } from '../../theme.ts'
import { ago, clip, day, daysBetween, fit } from './format.ts'
import { eventText, storeName, type Look, type LookEvent, type Movement } from './look.ts'

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const SPARK = '▁▂▃▄▅▆▇█'
const LABEL = 14

function bar(value: number, scale: number, width: number): string {
  const cells = Math.min(value / scale, 1) * width
  const whole = Math.floor(cells)
  const part = EIGHTHS[Math.round((cells - whole) * 7)] ?? ''
  return `${'█'.repeat(whole)}${part}`
}

function spark(values: number[], max: number): string {
  return values
    .map(
      (v) =>
        SPARK[Math.min(SPARK.length - 1, Math.round((v / Math.max(max, 1)) * (SPARK.length - 1)))],
    )
    .join('')
}

type Bucket = { label: string; from: string; to: string; days: number }

/** One row per day while they fit, then wider spans, so a long absence still fits. */
function buckets(days: string[], room: number): Bucket[] {
  const size = Math.max(1, Math.ceil(days.length / Math.max(room, 1)))
  const out: Bucket[] = []
  for (let i = 0; i < days.length; i += size) {
    const slice = days.slice(i, i + size)
    const from = slice[0]!
    const to = slice.at(-1)!
    const sameMonth = from.slice(0, 7) === to.slice(0, 7)
    const label =
      from === to ? day(from) : `${day(from)}-${sameMonth ? day(to).split(' ')[1] : day(to)}`
    out.push({ label, from, to, days: slice.length })
  }
  return out
}

function headline(target: Target): string {
  const key = HEADLINE_METRIC[target.ecosystem]
  const value = target.metrics[key]
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return `${value} users`
  if (target.ecosystem === 'github') return `★${value}`
  if (key === 'users') return `${compactNumber(value)} users`
  return `${compactNumber(value)} dl/wk`
}

/** Set-aside events are counted per day and reason, so robots take one line, not five. */
function folded(noise: LookEvent[]): LookEvent[] {
  const groups = new Map<string, LookEvent[]>()
  for (const e of noise) {
    if (e.noise === 'within habit') continue
    const key = `${e.at.slice(0, 10)} ${e.noise}`
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  return [...groups.values()].map((list) => {
    const first = list[0]!
    if (list.length === 1) return first
    const what = first.noise === 'bot' ? `${list.length} bot PRs` : `${list.length} ${first.noise}`
    return {
      ...first,
      text: `${what}: ${list.map((e) => e.text.split(' by ')[0]).join(', ')}`,
      noise: 'set aside',
    }
  })
}

function eventColor(e: LookEvent): string | undefined {
  if (e.noise) return theme.muted
  if (e.sign < 0) return theme.down
  if (e.sign > 0) return theme.up
  return theme.heading
}

/**
 * A project's window as a calendar: one line per day, the day's downloads against the
 * project's own habit, and whatever else happened that day beside it. A release and the
 * spike it caused land on the same line, which is the reading a table of totals hides.
 */
export function Story({
  look,
  m,
  width,
  height,
  header,
}: {
  look: Look
  m: Movement
  width: number
  height: number
  header: ReactNode
}) {
  const { project, flow } = m
  const days = daysBetween(look.anchor.at, look.latest.at)
  const timed = [...m.events.filter((e) => e.kind !== 'downloads'), ...folded(m.noise)].toSorted(
    (a, b) => a.at.localeCompare(b.at),
  )
  const standing: string[] = []
  if (project.drift.versions) {
    const split = project.drift.versions.map((v) => `${storeName(v.ecosystem)} ${v.version}`)
    standing.push(`stores disagree: ${split.join(', ')}`)
  }
  if (project.drift.unreleased) {
    const { pushedAt, publishedAt } = project.drift.unreleased
    standing.push(`unreleased work: pushed ${day(pushedAt)}, last release ${day(publishedAt)}`)
  }

  const fixed = 2 + 4 + (flow ? 2 : 0) + 3 + project.targets.length + standing.length + 2
  // Two weeks always get a line per day; past that, spans widen until the window fits.
  const rows = buckets(
    days,
    days.length <= 14 ? days.length : Math.max(height - fixed - timed.length, 7),
  )
  const barWidth = Math.max(10, Math.min(30, Math.floor(width / 4)))
  const usual = flow?.usualPerDay ?? 0
  const counted = (b: Bucket) => {
    if (!flow || b.from > flow.horizon) return null
    return flow.days
      .filter((p) => p.date >= b.from && p.date <= b.to)
      .reduce((t, p) => t + p.downloads, 0)
  }
  const scale = Math.max(
    ...rows.map((b) => counted(b) ?? 0),
    ...rows.map((b) => usual * b.days * 2),
    1,
  )
  const home = (e: LookEvent) => {
    const d = e.at.slice(0, 10)
    if (d < rows[0]!.from) return rows[0]!
    return rows.find((b) => d >= b.from && d <= b.to) ?? rows.at(-1)!
  }
  const stores = [...new Set(project.targets.map((t) => storeName(t.ecosystem)))].join(' · ')
  const lane = width - LABEL - 1 - (flow ? barWidth + 7 : 0)

  const lines: ReactNode[] = []
  for (const b of rows) {
    const value = counted(b)
    const happened = timed.filter((e) => home(e) === b)
    let cell: ReactNode = null
    if (flow && value === null) {
      cell = <Text color={theme.muted}>{fit('┄ not counted yet', barWidth + 7)}</Text>
    } else if (flow && value !== null) {
      let trace = bar(value, scale, barWidth)
      const mark = Math.round(((usual * b.days) / scale) * barWidth)
      if (usual > 0 && mark >= trace.length && mark < barWidth) trace = `${trace.padEnd(mark)}┊`
      cell = (
        <>
          <Text color={value > usual * b.days * 2 + 2 ? theme.up : undefined}>
            {fit(trace, barWidth)}
          </Text>
          <Text>{String(value).padStart(6)} </Text>
        </>
      )
    }
    const blank = flow ? ' '.repeat(barWidth + 7) : ''
    const first = happened[0]
    lines.push(
      <Text key={b.from} wrap="truncate">
        {' '}
        <Text color={theme.muted}>{fit(b.label, LABEL)}</Text>
        {cell}
        {first ? <Event e={first} lane={lane} /> : null}
      </Text>,
    )
    for (const e of happened.slice(1)) {
      lines.push(
        <Text key={`${b.from}${e.text}`} wrap="truncate">
          {' '.repeat(LABEL + 1)}
          {blank}
          <Event e={e} lane={lane} />
        </Text>,
      )
    }
  }

  const before = flow
    ? project.series.filter((p) => p.date <= look.anchor.at.slice(0, 10)).slice(-28)
    : []
  const max = Math.max(
    ...before.map((p) => p.downloads),
    ...(flow?.days ?? []).map((p) => p.downloads),
    1,
  )

  return (
    <Box flexDirection="column" height={height}>
      {header}
      <Text> </Text>
      <Text wrap="truncate">
        {' '}
        <Text bold>{project.name}</Text>
        <Text color={theme.muted}>{`  ${stores}`}</Text>
      </Text>
      <Text wrap="truncate" color={m.fresh ? theme.warn : theme.muted}>
        {' '}
        {m.fresh
          ? 'new: first seen inside this window, so nothing here is a change yet'
          : m.events.length
            ? m.events.map(eventText).join(' · ')
            : 'nothing moved beyond habit'}
      </Text>
      <Text> </Text>
      {lines}
      {flow ? (
        <>
          <Text> </Text>
          <Text wrap="truncate" color={theme.muted}>
            {' '}
            {fit('habit', LABEL)}
            {spark(
              before.map((p) => p.downloads),
              max,
            )}
            <Text color={theme.accent}>
              │
              {spark(
                flow.days.map((p) => p.downloads),
                max,
              )}
            </Text>
            {`  ┊ usual ~${Math.round(usual)}/day from the 28 days before ${day(look.anchor.at)} · counted to ${day(flow.horizon)}`}
          </Text>
        </>
      ) : null}
      <Text wrap="truncate" color={theme.muted}>
        {' '}
        {fit('', LABEL)}● dated ◦ first seen by a refresh
        {flow ? '' : ' · no store here serves a per-day history'}
      </Text>
      <Text> </Text>
      <Text color={theme.heading}> NOW</Text>
      {project.targets.map((t) => {
        const version = typeof t.metrics.version === 'string' ? t.metrics.version : ''
        return (
          <Text key={t.id} wrap="truncate">
            {' '}
            <Text color={theme.muted}>{fit(storeName(t.ecosystem), LABEL)}</Text>
            {fit(t.name, Math.min(30, Math.floor(width * 0.3)))} {fit(version, 8)}
            {fit(headline(t), 12)}
            <Text color={t.stale ? theme.warn : theme.muted}>
              {`${ago(t.fetchedAt)} ago${t.stale ? ', stale' : ''}`}
            </Text>
          </Text>
        )
      })}
      {standing.map((s) => (
        <Text key={s} wrap="truncate" color={theme.warn}>
          {' '}
          {s}
        </Text>
      ))}
      <Box flexGrow={1} />
      <Text wrap="truncate" color={theme.muted}>
        {' '}
        esc back [ ] earlier/later anchor o browser q quit, marks seen
      </Text>
    </Box>
  )
}

function Event({ e, lane }: { e: LookEvent; lane: number }) {
  const text = `${e.seenOnly ? '◦' : '●'} ${eventText(e)}${e.detail ? `: ${e.detail}` : ''}${e.noise ? ` (${e.noise})` : ''}`
  return <Text color={eventColor(e)}>{clip(text, lane)}</Text>
}
