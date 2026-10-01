import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { compactNumber, formatDate, span } from '../../../core/format.ts'
import type { Target } from '../../../core/types.ts'
import { homeUrl, projectItems, type Project } from '../../model.ts'
import { colorless } from '../../theme.ts'
import {
  buildWall,
  deltaSeg,
  ECOSYSTEM_GLYPH,
  G,
  type Badge,
  type Pane,
  type PaneId,
  type Seg,
  type State,
  type Tile,
  type Tone,
  type Wall,
} from './wall.ts'

// ---------------------------------------------------------------- palette

const hex = (value: string) => (colorless ? undefined : value)

const TONE: Record<Tone, string | undefined> = {
  attention: hex('#f9e2af'),
  up: hex('#a6e3a1'),
  down: hex('#f38ba8'),
  new: hex('#89dceb'),
  muted: hex('#7f849c'),
  plain: undefined,
}

const STATE_COLOR: Record<State, string | undefined> = {
  attention: TONE.attention,
  up: TONE.up,
  down: TONE.down,
  new: TONE.new,
  quiet: hex('#585b70'),
}

const PANE_COLOR: Record<PaneId, string | undefined> = {
  github: hex('#cba6f7'),
  registries: hex('#89b4fa'),
  stores: hex('#fab387'),
}

const CURSOR = hex('#f5e0dc')

/**
 * Line weight carries the reading colour cannot under NO_COLOR: heavy asks for a hand,
 * dashed is past its TTL, double is the cursor. Colour then only adds direction.
 */
type Lines = { tl: string; tr: string; bl: string; br: string; h: string; v: string }
const line = (s: string): Lines => {
  const [tl, tr, bl, br, h, v] = s.split('') as [string, string, string, string, string, string]
  return { tl, tr, bl, br, h, v }
}
const BORDER = {
  quiet: line('╭╮╰╯─│'),
  quietStale: line('╭╮╰╯┄┆'),
  heavy: line('┏┓┗┛━┃'),
  heavyStale: line('┏┓┗┛┅┇'),
  cursor: line('╔╗╚╝═║'),
}

const STATE_GLYPH: Record<State, string> = {
  attention: G.bolt,
  up: G.up,
  down: G.down,
  new: G.sparkle,
  quiet: '',
}

// ---------------------------------------------------------------- text fitting

const width = (segs: Seg[]) => segs.reduce((n, s) => n + s.text.length, 0)

function clip(segs: Seg[], room: number): Seg[] {
  if (width(segs) <= room) return segs
  const out: Seg[] = []
  let left = Math.max(0, room - 1)
  for (const seg of segs) {
    if (left <= 0) break
    out.push({ ...seg, text: seg.text.slice(0, left) })
    left -= seg.text.length
  }
  return [...out, { text: '…', tone: 'muted' }]
}

function fit(text: string, room: number): string {
  if (room <= 0) return ''
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`
}

function Segs({ segs, dim }: { segs: Seg[]; dim?: boolean }) {
  return (
    <>
      {segs.map((seg, i) => (
        <Text key={i} color={TONE[seg.tone ?? 'plain']} dimColor={dim}>
          {seg.text}
        </Text>
      ))}
    </>
  )
}

/**
 * Badges sit in per-pane slots so a column of tiles reads like a table, then the spare
 * width is shared out between them. A tile too narrow for its slots falls back to a
 * single-spaced run and loses the tail.
 */
function layout(badges: Badge[], slots: number[], room: number): Seg[] {
  const natural = badges.map((b, i) => Math.max(width(b), slots[i] ?? 0))
  const used = natural.reduce((a, b) => a + b, 0)
  const gaps = badges.length - 1
  if (used + gaps > room || gaps === 0) {
    return clip(
      badges.flatMap((b, i) => (i ? [{ text: ' ' }, ...b] : b)),
      room,
    )
  }
  const spare = room - used
  const out: Seg[] = []
  badges.forEach((badge, i) => {
    if (i) {
      const gap = Math.floor(spare / gaps) + (i <= spare % gaps ? 1 : 0)
      out.push({ text: ' '.repeat(gap) })
    }
    out.push(...badge, { text: ' '.repeat(natural[i]! - width(badge)) })
  })
  return out
}

// ---------------------------------------------------------------- tile

function TileView({
  tile,
  size,
  slots,
  selected,
  sibling,
}: {
  tile: Tile
  size: number
  slots: number[]
  selected: boolean
  sibling: boolean
}) {
  const heavy = tile.state === 'attention'
  const b = selected
    ? BORDER.cursor
    : heavy
      ? tile.stale
        ? BORDER.heavyStale
        : BORDER.heavy
      : tile.stale
        ? BORDER.quietStale
        : BORDER.quiet
  const color = selected ? CURSOR : STATE_COLOR[tile.state]
  // Staleness is the dashed line and the pane's stamp, so the corner stays for direction.
  const glyph = STATE_GLYPH[tile.state]

  const lead = `${b.tl}${b.h} `
  const marks: Seg[] = [
    ...(sibling ? [{ text: `${G.link} `, tone: 'new' as const }] : []),
    ...tile.marks.flatMap((m) => [m, { text: ' ' }]),
  ]
  const tail = glyph ? ` ${glyph}${b.h}${b.tr}` : `${b.h}${b.tr}`
  const room = size - lead.length - width(marks) - tail.length - 1
  const name = fit(tile.name, room)
  const fill = ` ${b.h.repeat(Math.max(0, room - name.length))}`

  const inner = size - 4
  const body = layout(tile.body, slots, inner)
  const foot = clip(
    tile.foot.flatMap((badge, i) => (i ? [{ text: ' ' }, ...badge] : badge)),
    size - 6,
  )

  return (
    <Box flexDirection="column" width={size}>
      <Text wrap="truncate">
        <Text color={color} bold={selected}>
          {lead}
        </Text>
        <Segs segs={marks} />
        <Text
          bold={selected || heavy || sibling}
          inverse={selected}
          color={selected ? undefined : sibling ? TONE.new : heavy ? TONE.attention : undefined}
        >
          {name}
        </Text>
        <Text color={color} bold={selected}>
          {fill}
          {tail.slice(0, glyph ? 1 : 0)}
        </Text>
        {glyph ? <Text color={STATE_COLOR[tile.state] ?? TONE.muted}>{glyph}</Text> : null}
        <Text color={color} bold={selected}>
          {glyph ? tail.slice(2) : tail}
        </Text>
      </Text>
      <Text wrap="truncate">
        <Text color={color} bold={selected}>
          {b.v}{' '}
        </Text>
        <Segs segs={body} />
        <Text>{' '.repeat(Math.max(0, inner - width(body)))}</Text>
        <Text color={color} bold={selected}>
          {' '}
          {b.v}
        </Text>
      </Text>
      <Text wrap="truncate">
        <Text color={color} bold={selected}>
          {b.bl}
          {b.h}{' '}
        </Text>
        <Segs segs={foot} />
        <Text color={color} bold={selected}>
          {' '}
          {b.h.repeat(Math.max(0, size - 5 - width(foot)))}
          {b.br}
        </Text>
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------- pane

type Grid = { cols: number; tile: number; pad: number }

/** Columns reflow with width: as many tiles as fit at the minimum, then they stretch. */
function grid(inner: number, wide: boolean): Grid {
  const min = wide ? 22 : 19
  const cols = Math.max(1, Math.floor(inner / min))
  const tile = Math.min(Math.floor(inner / cols), min + 6)
  return { cols, tile, pad: Math.floor((inner - tile * cols) / 2) }
}

function slotWidths(tiles: Tile[]): number[] {
  const out: number[] = []
  for (const tile of tiles) {
    tile.body.forEach((badge, i) => {
      out[i] = Math.max(out[i] ?? 0, width(badge))
    })
  }
  return out
}

function census(tiles: Tile[]): Seg[] {
  const states: State[] = ['attention', 'up', 'down', 'new']
  const segs: Seg[] = []
  for (const state of states) {
    const n = tiles.filter((t) => t.state === state).length
    if (n)
      segs.push({ text: ` ${STATE_GLYPH[state]} ${n} `, tone: state === 'quiet' ? 'muted' : state })
  }
  const stale = tiles.filter((t) => t.stale).length
  if (stale) segs.push({ text: ` ${G.hourglass} ${stale} `, tone: 'muted' })
  return segs.length ? segs : [{ text: ` ${G.check} quiet `, tone: 'muted' }]
}

function PaneView({
  pane,
  size,
  rows,
  focused,
  cursor,
  siblingKey,
  now,
  wide,
}: {
  pane: Pane
  size: number
  rows: number
  focused: boolean
  cursor: number
  siblingKey: string | null
  now: number
  wide: boolean
}) {
  const color = PANE_COLOR[pane.id]
  const g = grid(size - 2, wide)
  const total = Math.ceil(pane.tiles.length / g.cols)
  const visible = Math.max(1, Math.min(rows, total))
  const row = Math.floor(cursor / g.cols)
  const offset = Math.max(0, Math.min(row - visible + 1, total - visible))
  const slots = slotWidths(pane.tiles)

  const title: Seg[] = [{ text: ` ${pane.icons.join(' ')} ${pane.title} ` }]
  const totals: Seg[] = [
    { text: ` ${pane.tiles.length} `, tone: 'muted' },
    ...pane.totals.flatMap((badge) => [...badge, { text: '  ' }]),
  ]
  const stamp: Seg[] = pane.asOf
    ? [
        {
          text: ` ${pane.stale ? G.hourglass : G.clock} ${span(pane.asOf, new Date(now).toISOString())} `,
          tone: pane.stale ? 'attention' : 'muted',
        },
      ]
    : []
  const head = `╔═${focused ? '▶' : '═'}╡`
  const room = size - head.length - 1 - width(title) - width(stamp) - 3
  const shownTotals = clip(totals, Math.max(0, room))

  const above = offset * g.cols
  const below = Math.max(0, pane.tiles.length - (offset + visible) * g.cols)
  const scroll: Seg[] =
    above || below
      ? [
          {
            text: ` ${above ? `▲${above}` : ''}${above && below ? ' ' : ''}${below ? `▼${below}` : ''} `,
            tone: 'muted',
          },
        ]
      : []
  const states = census(pane.tiles)
  const bottomFill = size - 4 - width(scroll) - width(states)

  return (
    <Box flexDirection="column" width={size}>
      <Text wrap="truncate">
        <Text color={color} bold={focused} dimColor={!focused}>
          {head}
        </Text>
        <Text color={color} bold inverse={focused}>
          {title[0]!.text}
        </Text>
        <Text color={color} bold={focused} dimColor={!focused}>
          ╞
        </Text>
        <Segs segs={shownTotals} />
        <Text color={color} dimColor={!focused}>
          {'═'.repeat(Math.max(0, room - width(shownTotals)))}
        </Text>
        <Segs segs={stamp} />
        <Text color={color} bold={focused} dimColor={!focused}>
          {'══╗'}
        </Text>
      </Text>
      <Box
        flexDirection="column"
        borderStyle="double"
        borderTop={false}
        borderBottom={false}
        borderColor={color}
        borderDimColor={!focused}
        paddingLeft={g.pad}
      >
        {Array.from({ length: visible }, (_, r) => {
          const start = (offset + r) * g.cols
          const tiles = pane.tiles.slice(start, start + g.cols)
          return (
            <Box key={start} flexDirection="row">
              {tiles.map((tile, c) => (
                <TileView
                  key={tile.project.key}
                  tile={tile}
                  size={g.tile}
                  slots={slots}
                  selected={focused && start + c === cursor}
                  sibling={!focused && tile.project.key === siblingKey}
                />
              ))}
            </Box>
          )
        })}
      </Box>
      <Text wrap="truncate">
        <Text color={color} dimColor={!focused}>
          ╚═
        </Text>
        <Segs segs={scroll} />
        <Text color={color} dimColor={!focused}>
          {'═'.repeat(Math.max(0, bottomFill))}
        </Text>
        <Segs segs={states} />
        <Text color={color} dimColor={!focused}>
          ═╝
        </Text>
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------- detail

function fetched(t: Target, now: number): Seg[] {
  return [
    {
      text: `${t.stale ? G.hourglass : G.clock} ${span(t.fetchedAt, new Date(now).toISOString())}`,
      tone: t.stale ? 'attention' : 'muted',
    },
  ]
}

function num(t: Target, key: string): number | null {
  return typeof t.metrics[key] === 'number' ? t.metrics[key] : null
}

function metricSegs(t: Target, key: string, icon: string, unit = ''): Seg[] {
  const v = num(t, key)
  if (v === null) return [{ text: `${icon} ?`, tone: 'muted' }]
  return [
    { text: `${icon} ${compactNumber(v)}${unit}` },
    ...deltaSeg(t.deltas ? t.deltas[key] : null),
  ]
}

const join = (parts: Seg[][]) => parts.flatMap((p, i) => (i ? [{ text: '  ' }, ...p] : p))

function targetLine(t: Target, now: number, open?: Tile['open']): Seg[] {
  const version: Seg[] =
    typeof t.metrics.version === 'string'
      ? [{ text: `${G.tag} ${t.metrics.version}`, tone: 'muted' }]
      : []
  const head: Seg[] = [
    { text: `${ECOSYSTEM_GLYPH[t.ecosystem]} ` },
    { text: t.name, tone: 'plain' },
  ]
  switch (t.ecosystem) {
    case 'github':
      return join([
        head,
        metricSegs(t, 'stars', G.star),
        // A lone repo can borrow the split its tile derived from the items on disk.
        open && num(t, 'openPRs') === null && open.prs !== null
          ? [{ text: `${G.pr} ${open.prs}` }]
          : metricSegs(t, 'openPRs', G.pr),
        open && num(t, 'openIssues') === null && open.issues !== null
          ? [{ text: `${G.issue} ${open.issues}` }]
          : metricSegs(t, 'openIssues', G.issue),
        metricSegs(t, 'forks', G.fork),
        fetched(t, now),
      ])
    case 'npm':
    case 'pypi':
      return join([
        head,
        metricSegs(t, 'downloadsWeek', G.download, '/wk'),
        version,
        fetched(t, now),
      ])
    case 'amo':
      return join([
        head,
        metricSegs(t, 'users', G.users),
        metricSegs(t, 'rating', G.rating),
        version,
        fetched(t, now),
      ])
    default:
      return join([
        [{ text: `${G.chrome} ` }, { text: String(t.metrics.title ?? t.name) }],
        [{ text: `${G.users} ${typeof t.metrics.users === 'string' ? t.metrics.users : '?'}` }],
        metricSegs(t, 'rating', G.rating),
        version,
        fetched(t, now),
      ])
  }
}

/** Everything the wall knows about one project, domain by domain, then what is open on it. */
/**
 * Everything the wall knows about one project. The compact form is the inspector under a
 * tall wall: one line per target, the glyph naming its domain, and the reasons on one line.
 */
function detailLines(
  project: Project,
  wall: Wall,
  compact: boolean,
): { segs: Seg[]; head?: PaneId }[] {
  const out: { segs: Seg[]; head?: PaneId }[] = []
  const reasons: string[] = []
  for (const pane of wall.panes) {
    const tile = pane.tiles.find((t) => t.project.key === project.key)
    if (!tile) continue
    if (!compact)
      out.push({ segs: [{ text: `${pane.icons.join(' ')} ${pane.title}` }], head: pane.id })
    for (const t of tile.targets)
      out.push({
        segs: [
          { text: compact ? '' : '  ' },
          ...targetLine(t, wall.now, tile.targets.length === 1 ? tile.open : undefined),
        ],
      })
    if (compact) reasons.push(...tile.reasons)
    else
      for (const reason of tile.reasons) {
        out.push({ segs: [{ text: `  ${G.bolt} ${reason}`, tone: 'attention' }] })
      }
  }
  if (compact) {
    if (reasons.length)
      out.push({ segs: [{ text: `${G.bolt} ${reasons.join(' · ')}`, tone: 'attention' }] })
    return out
  }
  const items = projectItems(project)
  if (items.length) {
    out.push({ segs: [{ text: `${G.pr} ${G.issue} open` }], head: 'github' })
    for (const item of items) {
      out.push({
        segs: [
          { text: `  ${item.kind === 'pr' ? G.pr : G.issue} #${item.number} ` },
          { text: item.author, tone: 'muted' },
          { text: ` ${span(item.createdAt, new Date(wall.now).toISOString())} `, tone: 'muted' },
          { text: item.title },
        ],
      })
    }
  }
  return out
}

function Detail({
  project,
  wall,
  size,
  rows,
  compact = false,
}: {
  compact?: boolean
  project: Project
  wall: Wall
  size: number
  rows: number
}) {
  const lines = detailLines(project, wall, compact)
  const room = rows - 2
  const shown =
    lines.length > room
      ? [
          ...lines.slice(0, room - 1),
          { segs: [{ text: `  +${lines.length - room + 1} more`, tone: 'muted' as const }] },
        ]
      : lines
  const title = ` ${G.link} ${project.name} `
  const since = wall.baselineAt ? ` Δ since ${formatDate(wall.baselineAt)} ` : ''
  return (
    <Box flexDirection="column" width={size}>
      <Text wrap="truncate">
        <Text color={CURSOR}>╔═╡</Text>
        <Text bold inverse color={CURSOR}>
          {title}
        </Text>
        <Text color={CURSOR}>
          ╞{'═'.repeat(Math.max(0, size - title.length - since.length - 6))}
        </Text>
        <Text color={TONE.muted}>{since}</Text>
        <Text color={CURSOR}>═╗</Text>
      </Text>
      <Box
        flexDirection="column"
        borderStyle="double"
        borderTop={false}
        borderColor={CURSOR}
        paddingLeft={1}
        height={rows - 1}
      >
        {shown.map((l, i) => (
          <Text
            key={i}
            wrap="truncate"
            bold={Boolean(l.head)}
            color={l.head ? PANE_COLOR[l.head] : undefined}
          >
            <Segs segs={clip(l.segs, size - 4)} />
          </Text>
        ))}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------- chrome

function Header({ wall, size, busy }: { wall: Wall; size: number; busy: string | null }) {
  const brand = ' ▚▞ QUADRAPLEX '
  const sub = ' tile wall '
  const chips: Seg[] = wall.freshness.flatMap((f) => [
    {
      text: ` ${ECOSYSTEM_GLYPH[f.ecosystem]} ${span(f.oldest, new Date(wall.now).toISOString())}${f.stale ? G.hourglass : ''}`,
      tone: f.stale ? ('attention' as const) : ('muted' as const),
    },
  ])
  const right: Seg[] = busy
    ? [{ text: `${G.refresh} ${busy}… `, tone: 'new' }]
    : [
        ...chips,
        { text: wall.baselineAt ? `  Δ ${formatDate(wall.baselineAt)} ` : ' ', tone: 'muted' },
      ]
  const fitted = clip(right, size - brand.length - sub.length)
  return (
    <Text wrap="truncate">
      <Text bold inverse color={PANE_COLOR.github}>
        {brand}
      </Text>
      <Text color={TONE.muted}>{sub}</Text>
      <Text>{' '.repeat(Math.max(0, size - brand.length - sub.length - width(fitted)))}</Text>
      <Segs segs={fitted} />
    </Text>
  )
}

const LEGEND: Seg[] = [
  { text: '┏┓', tone: 'attention' },
  { text: ' act  ', tone: 'muted' },
  { text: '╭╮', tone: 'up' },
  { text: ' moved  ', tone: 'muted' },
  { text: '┄┆', tone: 'muted' },
  { text: ' stale  ', tone: 'muted' },
  { text: G.link, tone: 'new' },
  { text: ' same project ', tone: 'muted' },
]

function Footer({
  size,
  notice,
  open,
  position,
}: {
  size: number
  notice: string | null
  open: boolean
  position: string
}) {
  if (notice) {
    return (
      <Text wrap="truncate" color={TONE.attention}>
        {fit(` ${notice}`, size)}
      </Text>
    )
  }
  const full = open
    ? ' esc back  o open  q quit'
    : ' ←↑↓→ tile  ⇥ pane  ⏎ detail  o open  r refresh  q quit'
  const keys = full.length + position.length <= size ? full : ' ←↑↓→ ⇥ ⏎ o r q'
  const legend = size - keys.length - position.length >= width(LEGEND) + 2 ? LEGEND : []
  return (
    <Text wrap="truncate">
      <Text color={TONE.muted}>{keys}</Text>
      <Text>{' '.repeat(Math.max(0, size - keys.length - width(legend) - position.length))}</Text>
      <Segs segs={legend} />
      <Text color={TONE.muted}>{position}</Text>
    </Text>
  )
}

// ---------------------------------------------------------------- allocation

const PANE_CHROME = 2
const TILE_ROWS = 3

/**
 * Every pane shows its first row of tiles before any shows a second, then the focused
 * pane fills, then the rest share what is left. A pane cut short says how many tiles it
 * is holding back in its bottom border, so a short terminal never reads as a quiet wall.
 */
function allocate(need: number[], lines: number, focus: number): number[] {
  const rows = need.map(() => 0)
  let left = lines - need.length * PANE_CHROME
  if (left < need.length * TILE_ROWS) {
    rows[focus] = Math.max(1, Math.floor((lines - PANE_CHROME) / TILE_ROWS))
    return rows
  }
  need.forEach((n, i) => {
    if (n > 0 && left >= TILE_ROWS) {
      rows[i] = 1
      left -= TILE_ROWS
    }
  })
  const give = (i: number) => {
    if (left < TILE_ROWS || rows[i]! >= need[i]!) return false
    rows[i]! += 1
    left -= TILE_ROWS
    return true
  }
  while (give(focus));
  // Round-robin until a whole pass hands out nothing.
  while (need.map((_, i) => give(i)).some(Boolean));
  return rows
}

// ---------------------------------------------------------------- app

const BIN = fileURLToPath(new URL('../../../bin.ts', import.meta.url))
const INSPECTOR_MIN = 5

export function App({ wall: given }: { wall?: Wall }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const cols = stdout.columns ?? 80
  // One row short of the terminal, so the trailing newline never scrolls the header off.
  const height = (stdout.rows ?? 24) - 1
  const [wall, setWall] = useState<Wall>(() => given ?? buildWall())
  const [focus, setFocus] = useState(0)
  const [cursors, setCursors] = useState<number[]>(() => wall.panes.map(() => 0))
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const size = cols - 1
  const wide = cols >= 120
  const pane = wall.panes[focus]
  const cursor = Math.min(cursors[focus] ?? 0, Math.max(0, (pane?.tiles.length ?? 1) - 1))
  const tile = pane?.tiles[cursor]
  const g = grid(size - 2, wide)

  const setCursor = (paneIndex: number, value: number) =>
    setCursors((all) => all.map((c, i) => (i === paneIndex ? value : c)))

  /** Tab follows the project: landing on its tile in the next pane when it has one. */
  const switchPane = (next: number) => {
    const target = wall.panes[next]!
    const same = tile ? target.tiles.findIndex((t) => t.project.key === tile.project.key) : -1
    if (same >= 0) setCursor(next, same)
    setFocus(next)
  }

  /**
   * The wall never fetches. It shells out to the CLI for the focused pane's stores, one
   * `--only` at a time, then rereads the store.
   */
  const refresh = (all: boolean) => {
    if (busy || !pane) return
    const scopes = all ? [null] : pane.ecosystems
    setBusy(all ? 'refreshing all' : `refreshing ${pane.ecosystems.join(', ')}`)
    void (async () => {
      for (const scope of scopes) {
        await new Promise<void>((resolve) => {
          const args = scope ? ['refresh', '--only', scope] : ['refresh']
          const child = spawn(process.execPath, [BIN, ...args], { stdio: 'ignore' })
          child.on('exit', () => resolve())
          child.on('error', () => resolve())
        })
      }
      setWall(buildWall())
      setBusy(null)
    })()
  }

  useInput((input, key) => {
    setNotice(null)
    if (input === 'q' || (key.escape && !open)) return exit()
    if (open) {
      if (key.escape || key.return || key.backspace) setOpen(false)
      else if (input === 'o' && tile) openUrl(homeUrl(tile.project))
      return
    }
    if (!pane) return
    const n = pane.tiles.length
    if (key.tab) {
      const step = key.shift ? wall.panes.length - 1 : 1
      return switchPane((focus + step) % wall.panes.length)
    }
    if (/^[1-3]$/.test(input) && wall.panes[Number(input) - 1]) return switchPane(Number(input) - 1)
    if (key.rightArrow || input === 'l') setCursor(focus, Math.min(n - 1, cursor + 1))
    else if (key.leftArrow || input === 'h') setCursor(focus, Math.max(0, cursor - 1))
    else if (key.downArrow || input === 'j') {
      if (cursor + g.cols < n) setCursor(focus, cursor + g.cols)
      else if (Math.floor(cursor / g.cols) < Math.floor((n - 1) / g.cols)) setCursor(focus, n - 1)
      else if (focus + 1 < wall.panes.length) setFocus(focus + 1)
    } else if (key.upArrow || input === 'k') {
      if (cursor - g.cols >= 0) setCursor(focus, cursor - g.cols)
      else if (focus > 0) setFocus(focus - 1)
    } else if (key.return && tile) setOpen(true)
    else if (input === 'o' && tile) openUrl(paneUrl(tile))
    else if (input === 'r') refresh(false)
    else if (input === 'R') refresh(true)
  })

  if (wall.empty) {
    return (
      <Box flexDirection="column" width={cols} height={height}>
        <Header wall={wall} size={size} busy={busy} />
        <Text>The store is empty. Press r to refresh, or run "qplex refresh".</Text>
      </Box>
    )
  }

  const body = height - 2
  const need = wall.panes.map((p) => Math.ceil(p.tiles.length / g.cols))
  const rows = allocate(need, body, focus)
  const used = rows.reduce((sum, r) => sum + (r ? r * TILE_ROWS + PANE_CHROME : 0), 0)
  const spare = body - used
  // A tall terminal has room to read the selected project across every domain at once.
  const inspector = !open && spare >= INSPECTOR_MIN && tile
  const position = tile ? ` ${cursor + 1}/${pane?.tiles.length} ` : ''

  return (
    <Box flexDirection="column" width={cols} height={height}>
      <Header wall={wall} size={size} busy={busy} />
      <Box flexDirection="column" height={body}>
        {open && tile ? (
          <Detail project={tile.project} wall={wall} size={size} rows={body} />
        ) : (
          <>
            {wall.panes.map((p, i) =>
              rows[i] ? (
                <PaneView
                  key={p.id}
                  pane={p}
                  size={size}
                  rows={rows[i]}
                  focused={i === focus}
                  cursor={i === focus ? cursor : Math.min(cursors[i] ?? 0, p.tiles.length - 1)}
                  siblingKey={tile?.project.key ?? null}
                  now={wall.now}
                  wide={wide}
                />
              ) : null,
            )}
            {inspector ? (
              <Detail project={tile.project} wall={wall} size={size} rows={spare} compact />
            ) : null}
          </>
        )}
      </Box>
      <Footer size={size} notice={notice} open={open} position={position} />
    </Box>
  )
}

/** The page for the domain the cursor is in: the repo from GitHub, the package from npm. */
function paneUrl(tile: Tile): string {
  return tile.targets[0]?.url ?? homeUrl(tile.project)
}

function openUrl(url: string) {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
}
