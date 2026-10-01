import { spawn } from 'node:child_process'
import { useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { homeUrl, type Project } from '../../model.ts'
import { theme } from '../../theme.ts'
import { ago, clip, clock, day, fit, nameList, span, weekday } from './format.ts'
import { buildLook, eventText, storeName, type Look, type Movement, type Timeline } from './look.ts'
import { recordLook } from './marker.ts'
import { Story } from './story.tsx'

/** Where the anchor came from, because "since Sep 27" means little without "why then". */
export type AnchorSource = 'look' | 'flag' | 'default' | 'picked'

type Row =
  | { kind: 'move'; m: Movement }
  | {
      kind: 'group'
      id: GroupId
      label: string
      detail: string
      members: Movement[]
      open: boolean
    }
  | { kind: 'member'; m: Movement; text: string }
  | { kind: 'note'; label: string; detail: string }

type GroupId = 'minor' | 'cooling' | 'fresh' | 'quiet' | 'standing'

const METER = 5
const LABEL = 14

/** Five cells of significance, so the eye ranks before it reads. */
function meter(score: number): number {
  if (score >= 12) return 5
  if (score >= 8) return 4
  if (score >= 4) return 3
  if (score >= 2) return 2
  return 1
}

function signColor(sign: number): string | undefined {
  if (sign > 0) return theme.up
  if (sign < 0) return theme.down
  return theme.heading
}

function why(members: Movement[]): string {
  const kinds = members.map((m) => m.events[0]?.kind)
  const unreleased = kinds.filter((k) => k === 'unreleased').length
  if (unreleased === members.length) return 'pushed, not released'
  return 'small moves'
}

function standingText(project: Project): string {
  const { unreleased, versions } = project.drift
  const parts: string[] = []
  if (versions) parts.push(versions.map((v) => `${v.ecosystem} ${v.version}`).join(' vs '))
  if (unreleased)
    parts.push(`pushed ${day(unreleased.pushedAt)}, released ${day(unreleased.publishedAt)}`)
  return parts.join(' · ')
}

function quietText(m: Movement): string {
  if (m.flow && m.flow.days.length) {
    return `${m.flow.observed} dl, usual ~${Math.round(m.flow.expected)}`
  }
  return 'no change'
}

function rowsOf(look: Look, open: Set<GroupId>): Row[] {
  const rows: Row[] = look.moved.map((m) => ({ kind: 'move', m }))
  const group = (
    id: GroupId,
    members: Movement[],
    label: string,
    detail: string,
    text: (m: Movement) => string,
  ) => {
    if (members.length === 0) return
    rows.push({ kind: 'group', id, label, detail, members, open: open.has(id) })
    if (open.has(id)) for (const m of members) rows.push({ kind: 'member', m, text: text(m) })
  }
  group('minor', look.minor, `${look.minor.length} small`, why(look.minor), (m) =>
    m.events.map(eventText).join(' · '),
  )
  group('cooling', look.cooling, `${look.cooling.length} cooling`, 'below habit', (m) =>
    m.events.map(eventText).join(' · '),
  )
  group(
    'fresh',
    look.fresh,
    `${look.fresh.length} new`,
    'no baseline yet',
    (m) => `first seen ${day(m.firstSeen)}, deltas unknown`,
  )
  group('quiet', look.quiet, `${look.quiet.length} quiet`, 'within habit', quietText)
  const standing = look.projects.filter((p) => p.drift.versions || p.drift.unreleased)
  if (standing.length) {
    const splits = look.standing.versions.length
    const label = `${look.standing.unreleased.length} unreleased${splits ? `, ${splits} split` : ''}`
    group(
      'standing',
      standing.map((p) => look.byProject.get(p.key)!),
      label,
      'standing, not news',
      (m) => standingText(m.project),
    )
  }
  if (look.noise.length) {
    const bots = look.noise.filter((e) => e.noise === 'bot').length
    const badges = look.noise.filter((e) => e.noise === 'bucket label').length
    const parts = [bots ? `${bots} bot PRs` : '', badges ? `${badges} Chrome badge flicker` : '']
    rows.push({
      kind: 'note',
      label: `${look.noise.length} set aside`,
      detail: parts.filter(Boolean).join(', '),
    })
  }
  if (look.retired.length) {
    rows.push({
      kind: 'note',
      label: `${look.retired.length} retired`,
      detail: look.retired.join(', '),
    })
  }
  return rows
}

function openUrl(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
}

function Header({ look, source, width }: { look: Look; source: AnchorSource; width: number }) {
  const { anchor, latest } = look
  const refreshes = look.epochs.length - 1 - look.anchorIndex
  const reason = {
    look: 'your last look',
    flag: 'as asked',
    default: 'no last look yet, 3 days back',
    picked: 'picked with [ ]',
  }[source]
  const headline = `Since ${weekday(anchor.at)} ${day(anchor.at)}`
  const sub = ` ${clock(anchor.at)}, ${reason}`
  const right = `${span(anchor.at, latest.at)} · ${refreshes} refresh${refreshes === 1 ? '' : 'es'}`
  const pad = Math.max(width - 1 - headline.length - sub.length - right.length, 1)

  const stale = look.freshness.filter((f) => f.stale).map((f) => storeName(f.ecosystem))
  const facts = [
    `as of ${day(latest.at)} ${clock(latest.at)}, ${ago(latest.at)} ago`,
    look.horizon ? `downloads counted to ${day(look.horizon)}` : '',
    stale.length ? `${stale.join(', ')} stale` : 'nothing stale',
    look.errors ? `${look.errors} failing` : '',
  ].filter(Boolean)
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        {' '}
        <Text bold color={theme.accent}>
          {headline}
        </Text>
        <Text color={theme.muted}>{sub}</Text>
        {' '.repeat(pad)}
        <Text>{right}</Text>
      </Text>
      <Text wrap="truncate" color={theme.muted}>
        {' '}
        {facts.map((fact, i) => (
          <Text
            key={fact}
            color={
              fact.includes('stale ') || fact.endsWith(' stale') || fact.includes('failing')
                ? theme.warn
                : undefined
            }
          >
            {i ? ' · ' : ''}
            {fact}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

function Line({
  row,
  selected,
  width,
  nameWidth,
}: {
  row: Row
  selected: boolean
  width: number
  nameWidth: number
}) {
  const cursor = selected ? '›' : ' '
  if (row.kind === 'move') {
    const [top, ...rest] = row.m.events
    const filled = meter(row.m.score)
    const failing = row.m.project.targets.some((t) => t.errors?.length) ? '!' : ' '
    const room = width - 3 - METER - nameWidth - 1
    const lead = clip(eventText(top!), room)
    const trail = rest.length
      ? clip(`  ${rest.map(eventText).join(' · ')}`, room - lead.length)
      : ''
    return (
      <Text wrap="truncate">
        <Text color={theme.accent}>{cursor}</Text>
        <Text color={signColor(top!.sign)}>{'▮'.repeat(filled)}</Text>
        <Text color={theme.muted}>{'·'.repeat(METER - filled)}</Text>{' '}
        <Text bold={selected} inverse={selected}>
          {fit(row.m.project.name, nameWidth)}
        </Text>
        <Text color={theme.warn}>{failing}</Text>
        <Text color={signColor(top!.sign)}>{lead}</Text>
        <Text color={theme.muted}>{trail}</Text>
      </Text>
    )
  }
  if (row.kind === 'member') {
    return (
      <Text wrap="truncate">
        <Text color={theme.accent}>{cursor}</Text>
        {' '.repeat(METER + 3)}
        <Text bold={selected} inverse={selected}>
          {fit(row.m.project.name, nameWidth - 2)}
        </Text>{' '}
        <Text color={theme.muted}>{clip(row.text, width - nameWidth - METER - 4)}</Text>
      </Text>
    )
  }
  const glyph = row.kind === 'group' ? (row.open ? '▾' : '▸') : ' '
  const label = row.label.padEnd(LABEL)
  const names =
    row.kind === 'group' && !row.open
      ? nameList(
          row.members.map((m) => m.project.name),
          width - METER - 4 - label.length - row.detail.length - 4,
        )
      : ''
  return (
    <Text wrap="truncate" color={theme.muted}>
      <Text color={theme.accent}>{cursor}</Text>
      {' '.repeat(METER - 1)}
      {glyph}{' '}
      <Text color={selected ? undefined : theme.muted} bold={selected}>
        {label}
      </Text>{' '}
      <Text italic>{row.detail}</Text>
      {names ? `  ${names}` : ''}
    </Text>
  )
}

export function App({
  timeline,
  initial,
  source,
}: {
  timeline: Timeline
  initial: number
  source: AnchorSource
}) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = Math.max(stdout?.columns ?? 80, 50)
  const height = Math.max(stdout?.rows ?? 24, 12)
  const [anchorIndex, setAnchorIndex] = useState(initial)
  const [cursor, setCursor] = useState(0)
  // Small groups open on their own while the screen has room, so a quiet week shows its
  // detail and a busy one stays one line per group. Quiet never opens by itself.
  const [expanded, setExpanded] = useState<Set<GroupId>>(() => {
    const first = buildLook(timeline, { anchorIndex: initial })
    let room = height - 5 - first.moved.length - 8
    const open = new Set<GroupId>()
    for (const [id, members] of [
      ['minor', first.minor],
      ['fresh', first.fresh],
      ['cooling', first.cooling],
    ] as const) {
      if (members.length && members.length <= room) {
        open.add(id)
        room -= members.length
      }
    }
    return open
  })
  const [story, setStory] = useState<string | null>(null)
  const [moved, setMoved] = useState(false)

  const look = useMemo(() => buildLook(timeline, { anchorIndex }), [timeline, anchorIndex])
  const rows = useMemo(() => rowsOf(look, expanded), [look, expanded])
  const selectable = rows.map((r, i) => (r.kind === 'note' ? -1 : i)).filter((i) => i >= 0)
  const at = Math.min(cursor, selectable.length - 1)
  const selected = rows[selectable[at] ?? -1]

  const shift = (by: number) => {
    const next = Math.min(Math.max(anchorIndex + by, 0), Math.max(look.epochs.length - 2, 0))
    if (next !== anchorIndex) {
      setAnchorIndex(next)
      setMoved(true)
    }
  }

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      recordLook(look.latest.at)
      exit()
      return
    }
    if (input === '[') return shift(-1)
    if (input === ']') return shift(1)
    if (story) {
      if (key.escape || key.backspace || key.leftArrow || input === 'h') setStory(null)
      const m = look.byProject.get(story)
      if (input === 'o' && m) openUrl(homeUrl(m.project))
      return
    }
    if (key.downArrow || input === 'j') setCursor(Math.min(at + 1, selectable.length - 1))
    if (key.upArrow || input === 'k') setCursor(Math.max(at - 1, 0))
    if (input === 'g') setCursor(0)
    if (input === 'G') setCursor(selectable.length - 1)
    if (key.return || key.rightArrow || input === 'l') {
      if (selected?.kind === 'group') {
        const next = new Set(expanded)
        if (next.has(selected.id)) next.delete(selected.id)
        else next.add(selected.id)
        setExpanded(next)
      } else if (selected && selected.kind !== 'note') setStory(selected.m.project.key)
    }
    if (input === 'o' && selected && selected.kind !== 'note' && selected.kind !== 'group') {
      openUrl(homeUrl(selected.m.project))
    }
  })

  const effective: AnchorSource = moved ? 'picked' : source
  if (story) {
    const m = look.byProject.get(story)
    if (m)
      return (
        <Story
          look={look}
          m={m}
          width={width}
          height={height}
          header={<Header look={look} source={effective} width={width} />}
        />
      )
  }

  const nameWidth = Math.max(12, Math.min(24, Math.floor(width * 0.22)))
  const listHeight = height - 5
  const cursorRow = selectable[at] ?? 0
  const start = Math.min(
    Math.max(cursorRow - listHeight + 2, 0),
    Math.max(rows.length - listHeight, 0),
  )
  const visible = rows.slice(start, start + listHeight)
  const nothing = look.moved.length === 0

  return (
    <Box flexDirection="column" height={height}>
      <Header look={look} source={effective} width={width} />
      <Text> </Text>
      {nothing ? <Text color={theme.muted}> Nothing moved beyond habit.</Text> : null}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((row, i) => {
          const index = start + i
          const gap = row.kind === 'group' && rows[index - 1]?.kind === 'move'
          return (
            <Box key={`${index}`} flexDirection="column">
              {gap ? <Text> </Text> : null}
              <Line row={row} selected={index === cursorRow} width={width} nameWidth={nameWidth} />
            </Box>
          )
        })}
      </Box>
      <Text wrap="truncate" color={theme.muted}>
        {' '}
        ↑↓ move enter open [ ] earlier/later anchor o browser q quit, marks seen
      </Text>
    </Box>
  )
}
