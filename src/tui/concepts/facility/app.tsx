import { spawn } from 'node:child_process'
import { useCallback, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { compactNumber, formatDate, formatDelta, relativeAge, span } from '../../../core/format.ts'
import { HEADLINE_METRIC, type Target } from '../../../core/types.ts'
import { buildProjects, homeUrl, projectItems, type Project } from '../../model.ts'
import { sparkline } from '../../sparkline.tsx'
import { colorless } from '../../theme.ts'
import {
  buildWall,
  heatOrder,
  LIGHTS,
  lit,
  STORE_LETTERS,
  wallOrder,
  type Light,
  type Signal,
  type Tile,
  type Wall,
} from './derive.ts'
import { arrange, COLUMN_GAP, SIDE_WIDTH, type Grid } from './layout.ts'

// ---------------------------------------------------------------------------------------
// Segments: every line on the wall is built as styled runs of known width, so a tile can
// be truncated and padded exactly instead of trusting flexbox with forty of them.

type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean; inverse?: boolean }
type Line = Seg[]

const c = (name: string) => (colorless ? undefined : name)
const COLOR = {
  up: c('green'),
  down: c('red'),
  new: c('cyan'),
  warn: c('yellow'),
  muted: c('gray'),
  trace: c('green'),
  title: c('cyan'),
  focus: c('white'),
}

const chars = (text: string) => Array.from(text)
const width = (line: Line) => line.reduce((n, s) => n + chars(s.text).length, 0)

function fit(line: Line, w: number): Line {
  const out: Line = []
  let left = w
  for (const seg of line) {
    if (left <= 0) break
    const glyphs = chars(seg.text)
    if (glyphs.length <= left) {
      out.push(seg)
      left -= glyphs.length
    } else {
      out.push({ ...seg, text: glyphs.slice(0, Math.max(0, left - 1)).join('') + '…' })
      left = 0
    }
  }
  if (left > 0) out.push({ text: ' '.repeat(left) })
  return out
}

/** Left part truncated to make room for the right part, which is never cut. */
function spread(left: Line, right: Line, w: number): Line {
  const rw = width(right)
  if (rw >= w) return fit(right, w)
  return [...fit(left, w - rw), ...right]
}

function Row({ line }: { line: Line }) {
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim} inverse={s.inverse}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

// ---------------------------------------------------------------------------------------
// The tile vocabulary. Direction is a glyph, size is the density of the lit edge, and both
// survive NO_COLOR because neither depends on the colour that also carries them.

const GLYPH: Record<Signal, string> = { up: '▲', down: '▼', flat: '·', new: '◇', none: ' ' }
const EDGE = [' ', '░', '▒', '█']

const signalColor = (s: Signal) =>
  s === 'up' ? COLOR.up : s === 'down' ? COLOR.down : s === 'new' ? COLOR.new : COLOR.muted

function flags(tile: Tile, room = 5): Line {
  const out: Line = []
  if (tile.starred) out.push({ text: '★', color: COLOR.warn, bold: true })
  if (tile.versions) out.push({ text: '≠', color: COLOR.warn, bold: true })
  if (tile.unreleased) out.push({ text: '⇡', color: COLOR.warn })
  if (tile.errors.length) out.push({ text: '!', color: COLOR.down, bold: true })
  if (tile.lagging) out.push({ text: '◌', color: COLOR.muted })
  return out.slice(0, room)
}

function deltaSeg(tile: Tile): Seg | null {
  const h = tile.headline
  if (!h || h.delta === undefined) return null
  if (h.delta === 0) return null
  return { text: formatDelta(h.delta), color: signalColor(tile.signal), bold: tile.intensity === 3 }
}

/**
 * An extension has no trace, so its third line carries what the headline cannot: Google's
 * install bucket, which has no delta and never will, and the best-evidenced rating.
 */
function storeReadings(tile: Tile, dim: boolean): Line {
  const p = tile.project
  const out: Line = []
  if (p.reach?.bucket && tile.headline?.unit === 'u' && !tile.headline.text.endsWith('~')) {
    out.push({ text: `C ${p.reach.label}~`, color: COLOR.muted, dim })
  }
  if (p.rating)
    out.push({ text: `${out.length ? ' ' : ''}${p.rating.score}/5`, color: COLOR.muted, dim })
  return out
}

/** The stores trail a line only when the reading in front of them fits whole. */
function withStores(line: Line, tile: Tile, w: number): Line {
  const tail: Line = [{ text: ' ' }, { text: tile.stores, color: COLOR.muted, dim: true }]
  return width(line) + width(tail) <= w ? spread(line, tail, w) : fit(line, w)
}

function tileLines(tile: Tile, grid: Grid, focused: boolean, on: boolean): Line[] {
  const w = grid.tileWidth
  const moved = tile.signal === 'up' || tile.signal === 'down'
  const quiet = !moved && tile.signal !== 'new' && !tile.starred
  const dim = !on
  const edge: Seg = {
    text: on ? EDGE[tile.intensity]! : ' ',
    color: signalColor(tile.signal),
  }
  const glyph: Seg = { text: GLYPH[tile.signal], color: signalColor(tile.signal), bold: moved, dim }
  const name: Seg = {
    // Without colour there is no inverse either, so the focused name is bracketed.
    text: focused && colorless ? `[${tile.name}]` : tile.name,
    bold: tile.intensity >= 2 && on,
    dim: dim || (quiet && !tile.versions && !tile.unreleased),
  }
  const delta = deltaSeg(tile)
  const head = tile.headline
  const value: Line = head
    ? [
        { text: head.text, dim, bold: tile.intensity === 3 && on },
        { text: head.unit, color: COLOR.muted, dim },
        ...(delta ? [{ text: ' ' }, { ...delta, dim: dim || delta.dim }] : []),
      ]
    : [{ text: 'no reading', color: COLOR.muted, dim: true }]
  const marks = on
    ? flags(tile)
    : flags(tile).map((s) => ({ ...s, dim: true, bold: false, color: COLOR.muted }))

  let lines: Line[]
  switch (grid.level) {
    case 3: {
      const trace = sparkline(
        tile.project.series.map((p) => p.downloads),
        w - 4 - tile.stores.length,
      )
      const footer: Line = trace
        ? [{ text: '  ' }, { text: trace, color: COLOR.trace, dim: true }]
        : [{ text: '  ' }, ...storeReadings(tile, dim)]
      lines = [
        [edge, ...spread([glyph, { text: ' ' }, name], [{ text: ' ' }, ...marks], w - 1)],
        [edge, ...fit([{ text: '  ' }, ...value], w - 1)],
        [
          edge,
          ...spread(
            footer,
            [{ text: ' ' }, { text: tile.stores, color: COLOR.muted, dim: true }],
            w - 1,
          ),
        ],
      ]
      break
    }
    case 2:
      lines = [
        [edge, ...spread([glyph, { text: ' ' }, name], [{ text: ' ' }, ...marks], w - 1)],
        [edge, ...withStores([{ text: '  ' }, ...value], tile, w - 1)],
      ]
      break
    case 1:
      lines = [
        [
          edge,
          ...spread(
            [glyph, { text: ' ' }, name],
            [
              ...(delta ? [{ text: ' ' }, { ...delta, dim }] : []),
              ...(marks.length ? [{ text: ' ' }, ...marks] : []),
            ],
            w - 1,
          ),
        ],
      ]
      break
    case 0:
      lines = [[edge, ...spread([glyph, name], marks.slice(0, 1), w - 1)]]
      break
    default: {
      // No room for a name: movement wins the one glyph, drift takes it when nothing moved.
      const still = tile.signal === 'flat' || tile.signal === 'none'
      lines = [[edge, still && marks.length ? marks[0]! : glyph]]
    }
  }

  if (focused) {
    // The name line inverts and the edge turns into a cursor bar, so focus never hides
    // the reading underneath it.
    return lines.map((line, n) =>
      line.map((s, i) => {
        if (i === 0) return Object.assign({}, s, { text: '▌', color: COLOR.focus, dim: false })
        return n === 0 ? Object.assign({}, s, { inverse: true, dim: false }) : s
      }),
    )
  }
  return lines
}

// ---------------------------------------------------------------------------------------
// The wall's header states what is true of every tile once, so no tile has to repeat it:
// when it was read, what the deltas compare against, and how much of it is past TTL.

function counts(tiles: Tile[]) {
  const n = (f: (t: Tile) => boolean) => tiles.filter(f).length
  return {
    up: n((t) => t.signal === 'up'),
    down: n((t) => t.signal === 'down'),
    flat: n((t) => t.signal === 'flat' || t.signal === 'none'),
    fresh: n((t) => t.signal === 'new'),
    starred: n((t) => t.starred > 0),
    versions: n((t) => t.versions),
    unreleased: n((t) => t.unreleased),
  }
}

function headerLines(
  wall: Wall,
  cols: number,
  busy: string | null,
  light: Light,
  order: string,
): Line[] {
  const k = counts(wall.tiles)
  const title: Line = [
    { text: ' QUADRAPLEX', color: COLOR.title, bold: true },
    { text: ' facility ', color: COLOR.muted },
    { text: `${wall.tiles.length}`, bold: true },
    { text: ' projects ', color: COLOR.muted },
    { text: ' ' },
    { text: `▲${k.up}`, color: COLOR.up, bold: true },
    { text: ' ' },
    { text: `▼${k.down}`, color: COLOR.down, bold: true },
    { text: ' ' },
    { text: `·${k.flat}`, color: COLOR.muted },
    { text: ' ' },
    { text: `◇${k.fresh}`, color: k.fresh ? COLOR.new : COLOR.muted },
    { text: '  ' },
    { text: `★${k.starred}`, color: k.starred ? COLOR.warn : COLOR.muted },
    { text: ' ' },
    { text: `⇡${k.unreleased}`, color: k.unreleased ? COLOR.warn : COLOR.muted },
    { text: ' ' },
    { text: `≠${k.versions}`, color: k.versions ? COLOR.warn : COLOR.muted },
  ]
  const mode: Line = [
    ...(light !== 'all' ? [{ text: ` lit:${light}`, color: COLOR.warn }] : []),
    ...(order !== 'wall' ? [{ text: ` order:${order}`, color: COLOR.warn }] : []),
    ...(busy ? [{ text: ` ${busy}`, color: COLOR.new }] : []),
    { text: ' ' },
  ]

  const past = wall.pastTtl.reduce((n, p) => n + p.count, 0)
  const total = wall.tiles.reduce((n, t) => n + t.project.targets.length, 0)
  const ttlNote = wall.pastTtl
    .toSorted((a, b) => b.count - a.count)
    .map((p) => `${p.ecosystem} ttl ${p.ttl}`)
    .join(', ')
  const fresh: Line = [
    { text: ' read ', color: COLOR.muted },
    { text: wall.readAt ? relativeAge(wall.readAt) : 'never', bold: true },
    { text: wall.readAt ? ` (${stamp(wall.readAt)})` : '', color: COLOR.muted },
    { text: '  deltas vs ', color: COLOR.muted },
    { text: wall.baselineAt ? formatDate(wall.baselineAt) : 'nothing yet', bold: true },
    { text: '  ' },
    past
      ? { text: `${past}/${total} stale`, color: COLOR.warn, bold: true }
      : { text: 'all within TTL', color: COLOR.up },
    { text: past ? `: ${ttlNote}` : '', color: COLOR.muted },
  ]
  return [spread(title, mode, cols), fit(fresh, cols)]
}

const letter = (eco: string) => STORE_LETTERS.find(([e]) => e === eco)?.[1] ?? eco

function stamp(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${formatDate(iso)} ${hh}:${mm}`
}

function legend(cols: number): Line {
  const m = COLOR.muted
  const parts: Line = [
    { text: ' ░▒█', color: COLOR.up },
    { text: ' size ', color: m },
    { text: '▲▼', bold: true },
    { text: ' moved ', color: m },
    { text: '◇', color: COLOR.new },
    { text: ' new ', color: m },
    { text: '★', color: COLOR.warn },
    { text: ' stars ', color: m },
    { text: '⇡', color: COLOR.warn },
    { text: ' unreleased ', color: m },
    { text: '≠', color: COLOR.warn },
    { text: ' stores differ ', color: m },
    { text: '◌', color: m },
    { text: ' behind ', color: m },
  ]
  return spread(parts, [{ text: ' ? keys ', color: m }], cols)
}

// ---------------------------------------------------------------------------------------
// The focused tile, in words. This is the only place a tile's numbers get units, dates
// and per-store detail, because the wall is for noticing and the panel is for reading.

type Panel = { reading: Line[]; stores: Line[] }

function panelTitle(tile: Tile): Line {
  return [
    { text: GLYPH[tile.signal], color: signalColor(tile.signal), bold: true },
    { text: ' ' },
    { text: tile.project.name, bold: true },
    { text: `  ${tile.project.kind}`, color: COLOR.muted },
  ]
}

function headlineOf(t: Target): Line {
  const key = HEADLINE_METRIC[t.ecosystem]
  const v = t.metrics[key]
  if (v === null || v === undefined) return []
  const d = t.deltas ? (t.deltas[key] ?? null) : null
  const text = typeof v === 'number' ? compactNumber(v) : `${v}~`
  const unit = key === 'stars' ? '★' : key === 'users' ? 'u' : '/wk'
  const out: Line = [{ text: ` ${text}${unit}` }]
  if (typeof v === 'number' && d !== 0) {
    out.push({
      text: ` ${formatDelta(d)}`,
      color: d === null ? COLOR.new : d > 0 ? COLOR.up : COLOR.down,
    })
  }
  return out
}

function panelLines(tile: Tile, w: number, traceWidth: number): Panel {
  const p = tile.project
  const m = COLOR.muted
  const reading: Line[] = [panelTitle(tile)]

  const h = tile.headline
  if (h) {
    const base = p.targets.find((t) => t.deltaBaselineAt)?.deltaBaselineAt
    const delta = h.delta === 0 ? ({ text: '±0', color: m } as Seg) : deltaSeg(tile)
    reading.push([
      { text: '  ' },
      { text: h.text, bold: true },
      { text: h.unit === 'u' ? ' users' : h.unit === '/wk' ? ' dl/wk' : ' stars', color: m },
      ...(delta ? [{ text: '  ' }, delta] : [{ text: '  bucket, no delta', color: m }]),
      ...(delta && base ? [{ text: ` since ${formatDate(base)}`, color: m }] : []),
    ])
  }
  if (p.series.length) {
    reading.push([
      { text: '  90d ', color: m },
      {
        text: sparkline(
          p.series.map((s) => s.downloads),
          Math.max(8, traceWidth),
        ),
        color: COLOR.trace,
      },
    ])
  }
  if (p.stars && h?.unit !== '★') {
    const d = p.stars.delta
    reading.push([
      { text: '  ★ ', color: m },
      { text: String(p.stars.value) },
      ...(d
        ? [{ text: ` ${formatDelta(d)}`, color: d > 0 ? COLOR.up : COLOR.down, bold: true }]
        : []),
    ])
  }
  if (p.rating) {
    reading.push([
      { text: `  rated ${p.rating.score}/5 by ${p.rating.count} on ${p.rating.source}`, color: m },
    ])
  }
  if (p.drift.versions) {
    reading.push([
      { text: '  ≠ ', color: COLOR.warn, bold: true },
      { text: p.drift.versions.map((v) => `${v.ecosystem} ${v.version}`).join(' vs ') },
    ])
  }
  if (p.drift.unreleased) {
    const u = p.drift.unreleased
    reading.push([
      { text: '  ⇡ ', color: COLOR.warn },
      { text: `pushed ${formatDate(u.pushedAt)}, ` },
      { text: `${span(u.publishedAt, u.pushedAt)} after release`, color: COLOR.warn },
    ])
  }
  if (!h && !p.drift.versions && !p.drift.unreleased) {
    reading.push([{ text: '  the store publishes no count for this one', color: m }])
  }

  const stores: Line[] = []
  for (const t of p.targets) {
    const version = typeof t.metrics.version === 'string' ? t.metrics.version : ''
    const openCount =
      t.ecosystem === 'github' &&
      typeof t.metrics.openIssuesAndPRs === 'number' &&
      t.metrics.openIssuesAndPRs > 0
        ? ` ${t.metrics.openIssuesAndPRs} open`
        : ''
    stores.push([
      { text: `  ${letter(t.ecosystem)} `, color: m, bold: true },
      ...spread(
        [
          {
            text:
              (t.metrics.title as string | undefined) ??
              t.name.replace(/^shbernal\//, '').replace(/^@shbernal\//, ''),
          },
          { text: version ? ` ${version}` : '', color: m },
        ],
        [
          ...headlineOf(t),
          { text: openCount, color: COLOR.warn },
          {
            text: ` ${relativeAge(t.fetchedAt).replace(' ago', '')}`,
            color: t.stale ? COLOR.warn : m,
          },
          { text: t.stale ? '·stale' : '', color: COLOR.warn },
        ],
        Math.max(10, w - 4),
      ),
    ])
    for (const e of t.errors ?? []) stores.push([{ text: `    ! ${e}`, color: COLOR.down }])
  }
  const items = projectItems(p)
  if (items.length) {
    stores.push([{ text: 'open', color: m }])
    for (const it of items) {
      stores.push([
        { text: `  ${it.kind === 'pr' ? 'PR' : 'is'} `, color: it.kind === 'pr' ? COLOR.new : m },
        ...spread(
          [{ text: it.title }],
          [{ text: ` ${relativeAge(it.updatedAt).replace(' ago', '')}`, color: m }],
          Math.max(10, w - 5),
        ),
      ])
    }
  }
  if (tile.lagging) {
    stores.push([
      { text: `  ◌ oldest reading ${relativeAge(tile.oldest)}, behind the wall`, color: m },
    ])
  }
  return { reading: reading.map((l) => fit(l, w)), stores: stores.map((l) => fit(l, w)) }
}

function rule(title: Line, cols: number, label = ' stores '): Line {
  const half = Math.floor((cols - 3) / 2)
  const left: Line = [{ text: '── ', color: COLOR.muted }, ...title, { text: ' ' }]
  const pad = Math.max(0, half + 1 - width(left))
  const mid: Line = [...left, { text: '─'.repeat(pad) + label, color: COLOR.muted }]
  return fit(
    [...mid, { text: '─'.repeat(Math.max(0, cols - width(mid))), color: COLOR.muted }],
    cols,
  )
}

const KEYS: [string, string][] = [
  ['hjkl ←↓↑→', 'move across the wall'],
  ['tab', 'next lit tile'],
  ['f', 'light: all, moved, drift, stale'],
  ['s', 'order: wall (fixed), heat'],
  ['z', 'hide or show the panel'],
  ['o', 'open the project home'],
  ['r', 'run refresh, then reread'],
  ['q', 'quit'],
]

function helpLines(w: number): Line[] {
  return [
    [{ text: 'keys', bold: true }],
    ...KEYS.map(([k, d]): Line => [
      { text: `  ${k.padEnd(10)}`, bold: true },
      { text: d, color: COLOR.muted },
    ]),
  ].map((l) => fit(l, w))
}

// ---------------------------------------------------------------------------------------

function open(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
}

/** The published CLI, so the wall shells out to the same refresh a human would run. */
const BIN = new URL('../../../bin.ts', import.meta.url).pathname

/** Test-only: repeat the real portfolio so reflow can be judged at a hundred projects. */
function load(): Project[] {
  const projects = buildProjects()
  const clones = Number(process.env.QPLEX_FACILITY_CLONES ?? 1)
  if (clones <= 1) return projects
  return Array.from({ length: clones }, (_, i) =>
    projects.map((p) => ({ ...p, key: `${p.key}#${i}`, name: i ? `${p.name}-${i}` : p.name })),
  ).flat()
}

export function FacilityApp() {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const cols = stdout.columns ?? 100
  const rows = stdout.rows ?? 30

  const [projects, setProjects] = useState(load)
  const wall = useMemo(() => buildWall(projects), [projects])
  const [order, setOrder] = useState<'wall' | 'heat'>('wall')
  const [light, setLight] = useState<Light>('all')
  const [panel, setPanel] = useState(true)
  const [help, setHelp] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const tiles = useMemo(
    () => (order === 'wall' ? wallOrder(wall.tiles) : heatOrder(wall.tiles)),
    [wall, order],
  )
  // Focus opens on the wall's loudest tile, so the panel's first reading is the news.
  const [focusKey, setFocusKey] = useState<string>(
    () => heatOrder(wall.tiles)[0]?.project.key ?? '',
  )
  const index = Math.max(
    0,
    tiles.findIndex((t) => t.project.key === focusKey),
  )
  const focused = tiles[index]

  const showPanel = panel || help
  const {
    grid,
    placement,
    gridWidth,
    gridHeight,
    bottomLines: bottomH,
  } = arrange(tiles.length, cols, rows, showPanel)

  const runRefresh = useCallback(async () => {
    setBusy('refreshing')
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [BIN, 'refresh'], { stdio: 'ignore' })
      child.on('exit', () => resolve())
      child.on('error', () => resolve())
    })
    setBusy(null)
    setProjects(load())
  }, [])

  const moveTo = (i: number) => {
    const t = tiles[Math.max(0, Math.min(tiles.length - 1, i))]
    if (t) setFocusKey(t.project.key)
  }

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (help) return setHelp(false)
      return exit()
    }
    if (input === '?') return setHelp((h) => !h)
    const col = index % grid.columns
    if (input === 'l' || key.rightArrow) moveTo(index + 1)
    if (input === 'h' || key.leftArrow) moveTo(index - 1)
    if (input === 'j' || key.downArrow) {
      if (index + grid.columns < tiles.length) moveTo(index + grid.columns)
      else if (Math.floor(index / grid.columns) < grid.totalRows - 1) moveTo(tiles.length - 1)
    }
    if (input === 'k' || key.upArrow) moveTo(index - grid.columns < 0 ? col : index - grid.columns)
    if (input === 'g') moveTo(0)
    if (input === 'G') moveTo(tiles.length - 1)
    if (key.tab) {
      for (let step = 1; step <= tiles.length; step++) {
        const t = tiles[(index + step) % tiles.length]!
        if (light === 'all' ? lit(t, 'moved') : lit(t, light)) return setFocusKey(t.project.key)
      }
    }
    if (input === 'f') setLight((l) => LIGHTS[(LIGHTS.indexOf(l) + 1) % LIGHTS.length]!)
    if (input === 's') setOrder((o) => (o === 'wall' ? 'heat' : 'wall'))
    if (input === 'z') setPanel((p) => !p)
    if (input === 'o' && focused) open(homeUrl(focused.project))
    if (input === 'r' && !busy) void runRefresh()
  })

  // Scroll only when one-line cells still overflow, keeping the focused row in view.
  const focusRow = Math.floor(index / grid.columns)
  const firstRow = Math.max(
    0,
    Math.min(focusRow - Math.floor(grid.visibleRows / 2), grid.totalRows - grid.visibleRows),
  )

  const wallLines: Line[] = []
  for (let r = firstRow; r < firstRow + grid.visibleRows; r++) {
    const rowTiles = tiles.slice(r * grid.columns, (r + 1) * grid.columns)
    const rendered = rowTiles.map((t, i) =>
      tileLines(t, grid, r * grid.columns + i === index, lit(t, light)),
    )
    for (let l = 0; l < grid.lines; l++) {
      const line: Line = []
      rendered.forEach((tl, i) => {
        if (i) line.push({ text: ' '.repeat(COLUMN_GAP) })
        line.push(...tl[l]!)
      })
      wallLines.push(line)
    }
    if (grid.gap && r < firstRow + grid.visibleRows - 1) wallLines.push([{ text: ' ' }])
  }
  const scrolled =
    grid.visibleRows < grid.totalRows
      ? [
          {
            text: ` rows ${firstRow + 1}-${firstRow + grid.visibleRows} of ${grid.totalRows}`,
            color: COLOR.muted,
          },
        ]
      : []

  const sideW = SIDE_WIDTH
  let panelBody: Line[] = []
  if (showPanel && focused) {
    if (placement === 'side') {
      const pw = sideW - 3
      if (help) panelBody = helpLines(pw)
      else {
        const { reading, stores } = panelLines(focused, pw, pw - 6)
        panelBody = [
          ...reading,
          [{ text: ' ' }],
          [{ text: 'stores', color: COLOR.muted }],
          ...stores,
        ]
      }
    } else {
      // Side by side, so a strip six lines tall still carries the whole reading.
      const half = Math.floor((cols - 3) / 2)
      const { reading, stores } = help
        ? { reading: helpLines(half), stores: [] as Line[] }
        : panelLines(focused, half, half - 6)
      // The title rides in the rule above, so the strip spends no line on it.
      if (!help) reading.shift()
      // A strip too short for the open items keeps their count instead of half the list.
      const at = stores.findIndex((l) => l[0]?.text === 'open')
      if (at >= 0 && stores.length > bottomH) {
        const n = stores.length - at - 1
        stores.splice(at, stores.length - at, [
          { text: `open: ${n} item${n === 1 ? '' : 's'}, o opens the repo`, color: COLOR.muted },
        ])
      }
      const height = Math.min(bottomH, Math.max(reading.length, stores.length))
      panelBody = Array.from({ length: height }, (_, i) => [
        { text: ' ' },
        ...fit(reading[i] ?? [], half),
        { text: ' ' },
        ...(stores[i] ?? []),
      ])
    }
  }

  const header = headerLines(wall, cols, busy, light, order)
  const wallBox = (
    <Box flexDirection="column" width={gridWidth} height={gridHeight} flexShrink={0}>
      {wallLines.map((l, i) => (
        <Row key={i} line={l} />
      ))}
      {scrolled.length ? <Row line={scrolled} /> : null}
    </Box>
  )

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {header.map((l, i) => (
        <Row key={i} line={l} />
      ))}
      {placement === 'side' && showPanel ? (
        <Box flexDirection="row" height={gridHeight}>
          {wallBox}
          <Box
            flexDirection="column"
            width={sideW}
            marginLeft={1}
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderColor={COLOR.muted}
            paddingLeft={1}
          >
            {panelBody.map((l, i) => (
              <Row key={i} line={l} />
            ))}
          </Box>
        </Box>
      ) : (
        wallBox
      )}
      {placement === 'bottom' && showPanel ? (
        <Box flexDirection="column" height={bottomH + 1}>
          <Row
            line={
              help || !focused
                ? rule([{ text: 'keys', bold: true }], cols, '')
                : rule(panelTitle(focused), cols)
            }
          />
          {panelBody.map((l, i) => (
            <Row key={i} line={l} />
          ))}
        </Box>
      ) : null}
      <Row line={legend(cols)} />
    </Box>
  )
}
