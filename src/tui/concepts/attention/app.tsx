import { spawn } from 'node:child_process'
import { useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { formatDate, span } from '../../../core/format.ts'
import { homeUrl } from '../../model.ts'
import { sparkline } from '../../sparkline.tsx'
import { colorless, theme } from '../../theme.ts'
import { buildBoard, type Board, type Card, type Lane, type Tone } from './board.ts'

/**
 * Lanes, not rows. The left column holds what asks for an action, the right column what
 * only asks to be read. On a narrow terminal they stack in the same order.
 */
const ACT: Lane['id'][] = ['waiting', 'drift', 'unreleased']
const READ: Lane['id'][] = ['movement', 'blind']
const TWO_COLUMNS = 110

const TONE: Record<Tone, string | undefined> = {
  warn: theme.warn,
  up: theme.up,
  down: theme.down,
  muted: theme.muted,
  plain: undefined,
}

type Cursor = { lane: number; card: number }

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text.padEnd(width)
  return `${text.slice(0, Math.max(0, width - 1))}…`
}

function age(iso: string, now: number): string {
  return span(iso, new Date(now).toISOString())
}

// ---------------------------------------------------------------- header

/**
 * Knowledge, then trust. The first line says how old the board is as a whole and what
 * its deltas are measured against; the second breaks that age down by store, against the
 * TTL that store is held to, so "9h" reads as fine for npm and as stale for GitHub.
 */
function Header({ board, width }: { board: Board; width: number }) {
  const oldest = board.freshness.reduce((o, f) => (o === '' || f.oldest < o ? f.oldest : o), '')
  const staleCount = board.freshness.filter((f) => f.stale > 0).length
  const left = ' QUADRAPLEX  attention'
  const right = oldest
    ? `knowledge ${age(oldest, board.now)} old · deltas since ${formatDate(board.baselineAt ?? undefined)} `
    : 'store empty '
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={theme.heading}>
          {left}
        </Text>
        <Text color={theme.muted}>{right.padStart(Math.max(0, width - left.length))}</Text>
      </Text>
      <Text>
        <Text color={theme.muted}> trust </Text>
        {board.freshness.map((f) => {
          const stale = f.stale > 0
          const ttl = span(new Date(0).toISOString(), new Date(f.ttl).toISOString())
          return (
            <Text key={f.ecosystem}>
              <Text color={stale ? theme.warn : theme.muted}>
                {stale ? '! ' : '  '}
                {f.ecosystem} {age(f.oldest, board.now)}
              </Text>
              <Text color={theme.muted}>{stale ? ` > ttl ${ttl}` : ''} </Text>
            </Text>
          )
        })}
        {staleCount === 0 ? <Text color={theme.up}>all within TTL</Text> : null}
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------- lanes

/** The longest freshness claim that fits beside the label, staleness kept to the last. */
function laneStamp(lane: Lane, now: number, room: number): string {
  if (!lane.asOf) return ''
  const old = `${age(lane.asOf, now)} old`
  const stale = lane.stale.length ? `${lane.stale.join(', ')} stale` : ''
  const options = stale ? [`${old} · ${stale}`, stale, '! stale'] : [old]
  return options.find((option) => option.length + 2 <= room) ?? ''
}

function LaneHeader({
  lane,
  focused,
  width,
  now,
  hidden,
}: {
  lane: Lane
  focused: boolean
  width: number
  now: number
  hidden: number
}) {
  const live = lane.cards.filter((c) => !c.demoted).length
  const quiet = lane.cards.length - live
  const more = hidden ? `, +${hidden} off screen` : ''
  const count = `  ${live === 0 ? '0 urgent' : live}${quiet ? ` · ${quiet} routine` : ''}${more}`
  if (lane.cards.length === 0) {
    const label = ` ✓ ${lane.title.toUpperCase()}  `
    return (
      <Text>
        <Text color={theme.up}>{label}</Text>
        <Text color={theme.muted}>{fit(lane.passed, width - label.length)}</Text>
      </Text>
    )
  }
  const label = `${focused ? '▌' : ' '}${lane.title.toUpperCase()}${count}`
  const stamp = laneStamp(lane, now, width - label.length)
  return (
    <Text>
      <Text bold color={focused ? theme.accent : theme.heading}>
        {label}
      </Text>
      <Text color={lane.stale.length ? theme.warn : theme.muted}>
        {fit(` ${stamp}`, Math.max(0, width - label.length))
          .trimEnd()
          .padStart(Math.max(0, width - label.length))}
      </Text>
    </Text>
  )
}

function CardLine({ card, selected, width }: { card: Card; selected: boolean; width: number }) {
  const nameWidth = Math.min(22, Math.max(12, Math.floor(width * 0.3)))
  const tagWidth = Math.min(16, card.tag.length)
  const traceWidth = card.trace && width >= 50 ? 8 : 0
  const readingWidth = width - 3 - nameWidth - tagWidth - (traceWidth ? traceWidth + 1 : 0) - 2
  const dim = card.demoted
  const color = dim ? theme.muted : TONE[card.tone]
  return (
    <Text inverse={selected && colorless}>
      <Text color={theme.accent}>{selected ? ' ▸ ' : '   '}</Text>
      <Text color={dim ? theme.muted : undefined} bold={!dim && card.tone === 'warn'}>
        {fit(card.title, nameWidth)}
      </Text>
      <Text> </Text>
      <Text color={color}>{fit(card.reading, readingWidth)}</Text>
      {traceWidth ? (
        <Text color={dim ? theme.muted : theme.accent}>
          {' '}
          {sparkline(card.trace!, traceWidth).padEnd(traceWidth)}
        </Text>
      ) : null}
      <Text> </Text>
      <Text color={theme.muted}>{card.tag.slice(0, tagWidth).padStart(tagWidth)}</Text>
    </Text>
  )
}

/**
 * Rows are handed out so every lane shows its lead card before any lane shows its
 * second, and the focused lane is filled before the others get more. A lane cut short
 * says how many it is holding back, so a short terminal never reads as a quiet one.
 */
const wanted = (lane: Lane) => lane.cards.length

function allocate(
  lanes: Lane[],
  rows: number,
  focusedId: Lane['id'] | null,
): Map<Lane['id'], number> {
  const shown = new Map(lanes.map((l) => [l.id, 0]))
  let left = rows - lanes.length - Math.max(0, lanes.length - 1)
  if (left < 0) left += lanes.length - 1 // drop the gaps before dropping lanes
  for (const lane of lanes) {
    if (left > 0 && wanted(lane) > 0) {
      shown.set(lane.id, 1)
      left -= 1
    }
  }
  const focused = lanes.find((l) => l.id === focusedId)
  if (focused) {
    const extra = Math.min(left, wanted(focused) - shown.get(focused.id)!)
    shown.set(focused.id, shown.get(focused.id)! + extra)
    left -= extra
  }
  let progress = true
  while (left > 0 && progress) {
    progress = false
    for (const lane of lanes) {
      if (left > 0 && shown.get(lane.id)! < wanted(lane)) {
        shown.set(lane.id, shown.get(lane.id)! + 1)
        left -= 1
        progress = true
      }
    }
  }
  return shown
}

function Column({
  lanes,
  rows,
  width,
  cursor,
  order,
  now,
}: {
  lanes: Lane[]
  rows: number
  width: number
  cursor: Cursor
  order: Lane[]
  now: number
}) {
  const focusedId = order[cursor.lane]?.id ?? null
  const budget = allocate(lanes, rows, focusedId)
  const gaps = rows - lanes.length >= lanes.length * 2
  return (
    <Box flexDirection="column" width={width} height={rows} overflow="hidden">
      {lanes.map((lane, index) => {
        const focused = lane.id === focusedId
        const slots = budget.get(lane.id) ?? 0
        const total = lane.cards.length
        const cut = slots < total
        // One slot left means the card itself, with the overflow told in the header.
        const line = cut && slots >= 2
        const visible = line ? slots - 1 : slots
        // Scroll the focused lane so the cursor is always on screen.
        const start =
          focused && cut ? Math.max(0, Math.min(cursor.card - visible + 1, total - visible)) : 0
        const cards = lane.cards.slice(start, start + visible)
        const hidden = total - cards.length
        return (
          <Box key={lane.id} flexDirection="column" marginTop={index > 0 && gaps ? 1 : 0}>
            <LaneHeader
              lane={lane}
              focused={focused}
              width={width}
              now={now}
              hidden={cut && !line ? hidden : 0}
            />
            {cards.map((card, i) => (
              <CardLine
                key={`${card.title}${card.tag}`}
                card={card}
                width={width}
                selected={focused && start + i === cursor.card}
              />
            ))}
            {line ? (
              <Text color={theme.muted}>
                {'   '}+{hidden} more{focused ? '' : ', tab to open'}
              </Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

// ---------------------------------------------------------------- evidence

/**
 * Every claim a card makes, then what it rests on: each fetch and how old it is. A card
 * about many projects summarises its fetches per store, since that is the unit a refresh
 * can act on.
 */
function Evidence({
  card,
  lane,
  board,
  width,
  rows,
}: {
  card: Card
  lane: Lane
  board: Board
  width: number
  rows: number
}) {
  const targets = card.projects.flatMap((p) => p.targets)
  const stores = [...new Set(targets.map((t) => t.ecosystem))].map((ecosystem) => {
    const mine = targets.filter((t) => t.ecosystem === ecosystem)
    const oldest = mine.reduce((o, t) => (t.fetchedAt < o ? t.fetchedAt : o), mine[0]!.fetchedAt)
    const stale = mine.filter((t) => t.stale).length
    return { ecosystem, count: mine.length, oldest, stale }
  })
  const fixed = 3 + 2
  const wantSources = targets.length
  const sourceRows = Math.min(
    wantSources,
    Math.max(stores.length, rows - fixed - card.evidence.length),
  )
  const detailed = sourceRows >= targets.length
  const evidenceRows = Math.max(1, rows - fixed - (detailed ? targets.length : stores.length))
  const lines =
    card.evidence.length > evidenceRows
      ? [
          ...card.evidence.slice(0, evidenceRows - 1),
          `+${card.evidence.length - evidenceRows + 1} more`,
        ]
      : card.evidence
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <Text color={theme.muted}>{lane.title.toUpperCase()} › </Text>
        <Text bold>{card.title}</Text>
      </Text>
      <Text color={card.demoted ? theme.muted : TONE[card.tone]}>
        {fit(card.reading, width - 2)}
      </Text>
      <Text> </Text>
      {lines.map((line) => (
        <Text key={line}>{fit(`· ${line}`, width - 2)}</Text>
      ))}
      <Text> </Text>
      <Text color={theme.heading}>resting on</Text>
      {detailed
        ? targets.map((t) => (
            <Text key={t.id}>
              <Text color={t.stale ? theme.warn : theme.muted}>
                {t.stale ? '! ' : '  '}
                {fit(t.id, Math.min(44, width - 24))}
              </Text>
              <Text color={theme.muted}> fetched {age(t.fetchedAt, board.now)} ago</Text>
            </Text>
          ))
        : stores.map((s) => (
            <Text key={s.ecosystem} color={s.stale ? theme.warn : theme.muted}>
              {s.stale ? '! ' : '  '}
              {`${s.ecosystem} ×${s.count}, oldest fetched ${age(s.oldest, board.now)} ago${s.stale ? `, ${s.stale} stale` : ''}`}
            </Text>
          ))}
    </Box>
  )
}

// ---------------------------------------------------------------- app

export function App({ board: given }: { board?: Board }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = stdout.columns ?? 80
  const height = stdout.rows ?? 24
  const board = useMemo(() => given ?? buildBoard(), [given])

  const byId = new Map(board.lanes.map((l) => [l.id, l]))
  const twoColumns = width >= TWO_COLUMNS
  const left = ACT.map((id) => byId.get(id)!)
  const right = READ.map((id) => byId.get(id)!)
  // The cursor walks lanes in drawing order, skipping lanes that passed.
  const order = [...left, ...right].filter((l) => l.cards.length > 0)

  // Start on the first card that asks for something, not on a lane of chores.
  const [cursor, setCursor] = useState<Cursor>(() => {
    const lane = order.findIndex((l) => l.cards.some((c) => !c.demoted))
    return { lane: Math.max(0, lane), card: 0 }
  })
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const lane = order[cursor.lane]
  const card = lane?.cards[cursor.card]

  useInput((input, key) => {
    setNotice(null)
    if (input === 'q' || (key.escape && !open)) return exit()
    if (open) {
      if (key.escape || key.return || key.backspace) setOpen(false)
      return
    }
    if (!lane) return
    if (input === 'j' || key.downArrow) {
      if (cursor.card + 1 < lane.cards.length) setCursor({ ...cursor, card: cursor.card + 1 })
      else if (cursor.lane + 1 < order.length) setCursor({ lane: cursor.lane + 1, card: 0 })
    } else if (input === 'k' || key.upArrow) {
      if (cursor.card > 0) setCursor({ ...cursor, card: cursor.card - 1 })
      else if (cursor.lane > 0)
        setCursor({ lane: cursor.lane - 1, card: order[cursor.lane - 1]!.cards.length - 1 })
    } else if (key.tab) {
      const step = key.shift ? order.length - 1 : 1
      setCursor({ lane: (cursor.lane + step) % order.length, card: 0 })
    } else if (/^[1-5]$/.test(input)) {
      const target = order.findIndex((l) => l === [...left, ...right][Number(input) - 1])
      if (target >= 0) setCursor({ lane: target, card: 0 })
    } else if (key.return) {
      setOpen(true)
    } else if (input === 'o' && card) {
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
      spawn(command, [homeUrl(card.projects[0]!)], { detached: true, stdio: 'ignore' }).unref()
    } else if (input === 'r') {
      // The one action the board offers. Stubbed in this concept: it names the command
      // it would hand off to, scoped to the stores that are actually stale.
      setNotice(
        board.refreshArgs
          ? `would run: qplex ${board.refreshArgs.join(' ')}   (stub, nothing was fetched)`
          : 'every store is within its TTL, nothing to refresh',
      )
    }
  })

  const bodyRows = height - 2 - 1 - 2
  const columnWidth = twoColumns ? Math.floor((width - 3) / 2) : width - 1
  // A wide screen has room to show the evidence for the card under the cursor without
  // leaving the board, so the right column gives its spare rows to an inspector.
  const rightRows = right.reduce((n, l) => n + 1 + l.cards.length, 0) + right.length - 1
  const inspector = twoColumns && bodyRows - rightRows >= 10
  const quietNames = board.quiet.map((p) => p.name).join(', ')
  const refreshHint = board.refreshArgs
    ? `r refresh ${board.refreshArgs.includes('--only') ? board.refreshArgs.at(-1) : 'stale'}`
    : ''
  const keys = open
    ? 'esc back  o open  q quit'
    : ['j/k move', 'tab lane', 'enter evidence', refreshHint, 'q quit'].filter(Boolean).join('  ')

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header board={board} width={width - 1} />
      <Box height={1} />
      <Box height={bodyRows} flexDirection="row">
        {open && card && lane ? (
          <Evidence card={card} lane={lane} board={board} width={width - 1} rows={bodyRows} />
        ) : twoColumns ? (
          <>
            <Column
              lanes={left}
              rows={bodyRows}
              width={columnWidth}
              cursor={cursor}
              order={order}
              now={board.now}
            />
            <Box width={3} />
            <Box flexDirection="column" width={columnWidth}>
              <Column
                lanes={right}
                rows={inspector ? rightRows : bodyRows}
                width={columnWidth}
                cursor={cursor}
                order={order}
                now={board.now}
              />
              {inspector && card && lane ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={theme.muted}>{'─'.repeat(columnWidth)}</Text>
                  <Evidence
                    card={card}
                    lane={lane}
                    board={board}
                    width={columnWidth}
                    rows={bodyRows - rightRows - 2}
                  />
                </Box>
              ) : null}
            </Box>
          </>
        ) : (
          <Column
            lanes={[...left, ...right]}
            rows={bodyRows}
            width={columnWidth}
            cursor={cursor}
            order={order}
            now={board.now}
          />
        )}
      </Box>
      <Text color={theme.muted}>
        {fit(` quiet ${board.quiet.length}: ${quietNames}`, width - 1)}
      </Text>
      <Text>
        {notice ? (
          <Text color={theme.warn}>{fit(` ${notice}`, width - 1)}</Text>
        ) : (
          <Text color={theme.muted}>{fit(` ${keys}`, width - 1)}</Text>
        )}
      </Text>
    </Box>
  )
}
