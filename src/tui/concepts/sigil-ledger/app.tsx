import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { formatDate, formatDelta, metricLabel, metricText, span } from '../../../core/format.ts'
import type { Ecosystem } from '../../../core/types.ts'
import { colorless } from '../../theme.ts'
import {
  buildBoard,
  ICON,
  SIGILS,
  type Board,
  type Cell,
  type Column,
  type Pane,
  type PaneId,
  type Row,
  type Tone,
} from './board.ts'

/**
 * Every frame is composed as lines of coloured segments and handed to Ink already laid
 * out, because the borders carry titles, badges and counters that a Box border cannot.
 * Hierarchy is drawn by stroke: the summary bar is heavy, the focused pane heavy in its
 * domain colour, the others light and dim, the detail double.
 */

type Seg = { t: string; c?: string; b?: boolean; bg?: string }
type Line = Seg[]

const PALETTE = {
  github: '#cba6f7',
  registries: '#fab387',
  extensions: '#89dceb',
  up: '#a6e3a1',
  down: '#f38ba8',
  warn: '#f9e2af',
  muted: '#6c7086',
  quiet: '#a6adc8',
  frame: '#45475a',
  select: '#313244',
  accent: '#b4befe',
}
const C: Partial<typeof PALETTE> = colorless ? {} : PALETTE

const TONE: Record<Tone, string | undefined> = {
  up: C.up,
  down: C.down,
  muted: C.muted,
  warn: C.warn,
  plain: undefined,
}

const STROKE = {
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', ml: '┠', mr: '┨' },
  light: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', ml: '├', mr: '┤' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', ml: '╟', mr: '╢' },
}
type Stroke = (typeof STROKE)[keyof typeof STROKE]

const WIDE = 110
const BIN = fileURLToPath(new URL('../../../bin.ts', import.meta.url))

// ---------------------------------------------------------------- line primitives

const sw = (s: string) => Bun.stringWidth(s)
const width = (line: Line) => line.reduce((n, s) => n + sw(s.t), 0)

function clip(s: string, w: number): string {
  if (w <= 0) return ''
  if (sw(s) <= w) return s
  let out = ''
  for (const ch of s) {
    if (sw(out + ch) > w - 1) break
    out += ch
  }
  return `${out}…`
}
const padR = (s: string, w: number) => {
  const c = clip(s, w)
  return c + ' '.repeat(Math.max(0, w - sw(c)))
}
const padL = (s: string, w: number) => {
  const c = clip(s, w)
  return ' '.repeat(Math.max(0, w - sw(c))) + c
}

/** Truncates segment by segment, so a line never pushes its right border off the edge. */
function fit(line: Line, w: number): Line {
  const out: Line = []
  let used = 0
  for (const seg of line) {
    const room = w - used
    if (room <= 0) break
    const t = sw(seg.t) <= room ? seg.t : clip(seg.t, room)
    out.push({ ...seg, t })
    used += sw(t)
  }
  if (used < w) out.push({ t: ' '.repeat(w - used) })
  return out
}

/** A border with a label at the left and one at the right, the rule filling between. */
function rule(
  stroke: Stroke,
  w: number,
  ends: [string, string],
  left: Line,
  right: Line,
  color: string | undefined,
  bold = false,
): Line {
  const edge = (t: string): Seg => ({ t, c: color, b: bold })
  const pad = (l: Line): Line => (l.length ? [{ t: ' ' }, ...l, { t: ' ' }] : [])
  let l = pad(left)
  let r = pad(right)
  const room = w - 3
  if (width(l) + width(r) > room) r = []
  if (width(l) > room) l = fit(l, room)
  const gap = room - width(l) - width(r)
  return [
    edge(ends[0] + stroke.h),
    ...l,
    edge(stroke.h.repeat(Math.max(0, gap))),
    ...r,
    edge(ends[1]),
  ]
}

function boxed(
  stroke: Stroke,
  w: number,
  body: Line,
  color: string | undefined,
  bg?: string,
): Line {
  const inner = fit(body, w - 2).map((s) => (bg ? { ...s, bg } : s))
  return [{ t: stroke.v, c: color }, ...inner, { t: stroke.v, c: color }]
}

function delta(d: number | null | undefined): Seg | null {
  if (d === undefined) return null
  if (d === null) return { t: 'new', c: C.muted }
  if (d === 0) return { t: '·', c: C.muted }
  return { t: formatDelta(d), c: d > 0 ? C.up : C.down }
}

const ago = (iso: string, now: number) => span(iso, new Date(now).toISOString())

// ---------------------------------------------------------------- sigils

const HEALTH_TONE = { ok: C.up, partial: C.warn, blind: C.muted, stale: C.warn, error: C.down }
const MOVE_TONE = { up: C.up, down: C.down, held: C.muted, new: C.accent, none: undefined }
const FLAG_TONE = {
  waiting: C.warn,
  drift: C.down,
  unreleased: C.accent,
  bots: C.muted,
  none: undefined,
}

function strip(row: Row): Line {
  return [
    { t: SIGILS.health[row.health][0], c: HEALTH_TONE[row.health] },
    { t: SIGILS.move[row.move][0], c: MOVE_TONE[row.move] },
    { t: SIGILS.flag[row.flag][0], c: FLAG_TONE[row.flag], b: row.flag === 'waiting' },
  ]
}

const quiet = (row: Row) => row.flag === 'none' && (row.move === 'held' || row.move === 'none')

// ---------------------------------------------------------------- ledger pane

type Layout = { columns: Column[]; value: number[]; delta: number[]; name: number }

/** Columns are sized by their data and dropped by priority until the name has room. */
function layout(pane: Pane, inner: number): Layout {
  const measure = (col: Column) => {
    const cells = pane.rows.map((r) => r.cells[col.id]!)
    const value = Math.max(1, ...cells.map((c) => sw(c.text)))
    const d = col.delta ? Math.max(3, ...cells.map((c) => sw(delta(c.delta)?.t ?? ''))) : 0
    return { value, delta: d }
  }
  let columns = pane.columns
  const minName = inner > 60 ? 16 : 12
  const used = (cols: Column[]) =>
    cols.reduce((n, c) => {
      const m = measure(c)
      return n + 2 + m.value + (m.delta ? m.delta + 1 : 0)
    }, 6)
  while (columns.length > 1 && inner - used(columns) < minName) {
    const worst = Math.max(...columns.map((c) => c.priority))
    const drop = columns.findLastIndex((c) => c.priority === worst)
    columns = columns.filter((_, i) => i !== drop)
  }
  const sizes = columns.map(measure)
  return {
    columns,
    value: sizes.map((s) => s.value),
    delta: sizes.map((s) => s.delta),
    name: Math.max(4, inner - used(columns)),
  }
}

function cellSegs(cell: Cell, value: number, deltaW: number, bg?: string): Line {
  const out: Line = [{ t: padL(cell.text, value), c: cell.tone ? TONE[cell.tone] : undefined }]
  if (deltaW) {
    const d = delta(cell.delta)
    out.push({ t: ' ' })
    out.push(d ? { ...d, t: padR(d.t, deltaW) } : { t: ' '.repeat(deltaW) })
  }
  return bg ? out.map((s) => ({ ...s, bg })) : out
}

function freshnessLabel(pane: Pane, now: number): Line {
  if (!pane.asOf) return [{ t: 'empty', c: C.muted }]
  const stale = pane.stale > 0
  return [
    {
      t: `${stale ? ICON.hourglass : ICON.clock} ${ago(pane.asOf, now)}`,
      c: stale ? C.warn : C.muted,
    },
  ]
}

function badgeSegs(pane: Pane, color: string | undefined): Line {
  const out: Line = []
  for (const badge of pane.badges) {
    if (out.length) out.push({ t: ' ' })
    out.push({ t: `${badge.icon} `, c: color })
    out.push({ t: badge.text, c: badge.tone ? TONE[badge.tone] : undefined, b: true })
    const d = delta(badge.delta)
    if (d && badge.delta) out.push({ t: ` ${d.t}`, c: d.c })
  }
  return out
}

type PaneProps = {
  pane: Pane
  w: number
  h: number
  focused: boolean
  cursor: number
  now: number
}

function ledger({ pane, w, h, focused, cursor, now }: PaneProps): Line[] {
  const color = C[pane.id]
  const stroke = focused ? STROKE.heavy : STROKE.light
  const edge = focused ? color : C.frame
  const inner = w - 2
  const lay = layout(pane, inner)
  const title: Line = [
    { t: `${pane.icon} `, c: color },
    { t: pane.title, c: focused ? color : C.quiet, b: focused },
  ]
  const lines: Line[] = [
    rule(stroke, w, [stroke.tl, stroke.tr], title, freshnessLabel(pane, now), edge, focused),
  ]

  // Header: the strip's three slots, then each column's icon over its value's right edge.
  const header: Line = [
    { t: ' ' },
    { t: '┄┄┄', c: C.frame },
    { t: ' ' },
    { t: padR(`${ICON.repo} ${pane.rows.length}`, lay.name), c: C.muted },
  ]
  lay.columns.forEach((col, i) => {
    header.push({ t: '  ' })
    header.push({ t: padL(col.icon, lay.value[i]!), c: color })
    if (lay.delta[i]) header.push({ t: ' '.repeat(lay.delta[i] + 1) })
  })
  lines.push(boxed(stroke, w, header, edge))
  lines.push([
    { t: stroke.ml, c: edge },
    { t: '┄'.repeat(inner), c: C.frame },
    { t: stroke.mr, c: edge },
  ])

  const visible = Math.max(1, h - 4)
  const top = Math.min(
    Math.max(0, cursor - Math.floor(visible / 2)),
    Math.max(0, pane.rows.length - visible),
  )
  const slice = pane.rows.slice(top, top + visible)
  for (const [k, row] of slice.entries()) {
    const selected = focused && top + k === cursor
    const bg = selected ? C.select : undefined
    const body: Line = [
      { t: selected ? '▌' : ' ', c: color },
      ...strip(row),
      { t: ' ' },
      {
        t: clip(row.name, lay.name - 1),
        c: selected ? undefined : quiet(row) ? C.quiet : undefined,
        b: selected || row.flag === 'waiting',
      },
      // Leader dots carry the eye from the name to its numbers, as in a printed ledger.
      {
        t: ` ${'·'.repeat(Math.max(0, lay.name - 1 - sw(clip(row.name, lay.name - 1))))}`,
        c: C.frame,
      },
    ]
    lay.columns.forEach((col, i) => {
      body.push({ t: '  ' })
      body.push(...cellSegs(row.cells[col.id]!, lay.value[i]!, lay.delta[i]!))
    })
    lines.push(boxed(stroke, w, body, edge, bg))
  }
  while (lines.length < h - 1) lines.push(boxed(stroke, w, [], edge))

  const below = pane.rows.length - top - slice.length
  const more: Line = [
    ...(top > 0 ? [{ t: `↑${top}`, c: C.muted }] : []),
    ...(top > 0 && below > 0 ? [{ t: ' ' }] : []),
    ...(below > 0 ? [{ t: `↓${below}`, c: C.muted }] : []),
  ]
  const position: Line = pane.rows.length
    ? [
        {
          t: `${Math.min(cursor + 1, pane.rows.length)}/${pane.rows.length}`,
          c: focused ? color : C.muted,
        },
      ]
    : []
  lines.push(rule(stroke, w, [stroke.bl, stroke.br], more, position, edge, focused))
  return lines
}

/** A pane folded to its border: what it holds, read off the badges, one keypress away. */
function folded(pane: Pane, w: number, index: number, now: number): Line {
  const color = C[pane.id]
  const left: Line = [
    { t: `${index + 1} `, c: C.muted },
    { t: `▸ ${pane.icon} `, c: color },
    { t: pane.title, c: C.quiet },
    { t: '  ' },
    ...badgeSegs(pane, color),
  ]
  return rule(STROKE.light, w, ['╶', '╴'], left, freshnessLabel(pane, now), C.frame)
}

// ---------------------------------------------------------------- detail

const ECO_ICON: Record<Ecosystem, string> = {
  github: ICON.github,
  npm: ICON.npm,
  pypi: ICON.pypi,
  amo: ICON.firefox,
  cws: ICON.chrome,
}
const BOT = /\[bot\]$|^dependabot|^renovate/i

function detailBody(pane: Pane, row: Row, inner: number, now: number): Line[] {
  const out: Line[] = []
  const words: Line = []
  for (const [slot, key] of [
    ['health', row.health],
    ['move', row.move],
    ['flag', row.flag],
  ] as const) {
    const [glyph, label] = (SIGILS[slot] as Record<string, readonly [string, string]>)[key]!
    if (!label) continue
    words.push({
      t: `${glyph} `,
      c: { health: HEALTH_TONE, move: MOVE_TONE, flag: FLAG_TONE }[slot][key as never],
    })
    words.push({ t: `${label}   `, c: C.quiet })
  }
  out.push([{ t: ' ' }, ...words])
  const u = row.project.drift.unreleased
  if (row.flag === 'unreleased' && u) {
    out.push([
      { t: ` ${SIGILS.flag.unreleased[0]} `, c: FLAG_TONE.unreleased },
      {
        t: `pushed ${formatDate(u.pushedAt)}, ${span(u.publishedAt, u.pushedAt)} after the release of ${formatDate(u.publishedAt)}`,
        c: C.quiet,
      },
    ])
  }
  const versions = row.project.drift.versions
  if (versions) {
    out.push([
      { t: ` ${SIGILS.flag.drift[0]} `, c: FLAG_TONE.drift },
      { t: versions.map((v) => `${ECO_ICON[v.ecosystem]} ${v.version}`).join('   '), c: C.quiet },
    ])
  }
  for (const target of row.targets) {
    out.push([])
    out.push([
      { t: ` ${ECO_ICON[target.ecosystem]} `, c: C[pane.id] },
      { t: target.id, b: true },
      { t: `  ${target.url}`, c: C.muted },
    ])
    // Metrics flow into as many columns as the width holds, label dim, value bright.
    const cells = Object.entries(target.metrics)
      .filter(([, v]) => v !== null && v !== 'no')
      .map(([k, v]): Line => {
        const d = target.deltas
          ? delta(target.deltas[k] ?? (typeof v === 'number' ? null : undefined))
          : delta(null)
        return [
          { t: `${metricLabel(k)} `, c: C.muted },
          { t: metricText(v) },
          ...(d && typeof v === 'number' ? [{ t: ` ${d.t}`, c: d.c }] : []),
        ]
      })
    const cellW = Math.max(...cells.map(width), 10) + 3
    const per = Math.max(1, Math.floor((inner - 3) / cellW))
    for (let i = 0; i < cells.length; i += per) {
      const line: Line = [{ t: '   ' }]
      for (const cell of cells.slice(i, i + per)) line.push(...fit(cell, cellW))
      out.push(line)
    }
  }
  if (row.items.length) {
    out.push([])
    out.push([{ t: ` ${ICON.issue} ${ICON.pr}  open, newest activity first`, c: C.muted }])
    for (const item of row.items) {
      const bot = BOT.test(item.author)
      out.push([
        { t: '   ' },
        { t: bot ? SIGILS.flag.bots[0] : ICON.person, c: bot ? C.muted : C.warn },
        { t: ` ${item.kind === 'pr' ? ICON.pr : ICON.issue} `, c: C[pane.id] },
        { t: `#${item.number} `, c: C.muted },
        { t: item.title },
        { t: `  ${item.author} · ${ago(item.updatedAt, now)}`, c: C.muted },
      ])
    }
  }
  return out
}

function detail(pane: Pane, row: Row, w: number, h: number, offset: number, now: number): Line[] {
  const color = C[pane.id]
  const s = STROKE.double
  const body = detailBody(pane, row, w - 2, now)
  const visible = Math.max(1, h - 2)
  const top = Math.min(offset, Math.max(0, body.length - visible))
  const lines: Line[] = [
    rule(
      s,
      w,
      [s.tl, s.tr],
      [{ t: `${pane.icon} `, c: color }, ...strip(row), { t: ` ${row.name}`, b: true }],
      [{ t: 'esc', c: C.muted }],
      color,
      true,
    ),
  ]
  for (const line of body.slice(top, top + visible)) lines.push(boxed(s, w, line, color))
  while (lines.length < h - 1) lines.push(boxed(s, w, [], color))
  lines.push(
    rule(s, w, [s.bl, s.br], [], [{ t: formatDate(row.targets[0]?.fetchedAt), c: C.muted }], color),
  )
  return lines
}

// ---------------------------------------------------------------- chrome

function summaryBar(board: Board, w: number, focus: number, status: Line): Line[] {
  const s = STROKE.heavy
  const color = C.accent
  const title: Line = [
    { t: '◈ ', c: color },
    { t: 'QUADRAPLEX', c: color, b: true },
    { t: ' sigil ledger', c: C.muted },
  ]
  const since: Line = board.baselineAt
    ? [{ t: `Δ since ${formatDate(board.baselineAt)}`, c: C.muted }]
    : []
  // Badge groups shed their tail badges, longest group first, until the bar fits.
  const panes = board.panes.map((p) => ({ ...p, badges: [...p.badges] }))
  const group = (p: Pane, i: number): Line => [
    { t: `${i + 1}`, c: i === focus ? C[p.id] : C.muted, b: i === focus },
    { t: ' ' },
    ...badgeSegs(p, C[p.id]),
  ]
  const build = () => {
    const out: Line = [{ t: ' ' }]
    panes.forEach((p, i) => {
      if (i) out.push({ t: '  ┊  ', c: C.frame })
      out.push(...group(p, i))
    })
    return out
  }
  let row = build()
  while (width(row) > w - 3) {
    const longest = panes.reduce((a, b) => (b.badges.length > a.badges.length ? b : a))
    if (longest.badges.length <= 1) break
    longest.badges.pop()
    row = build()
  }
  return [
    rule(s, w, [s.tl, s.tr], title, since, color, true),
    boxed(s, w, row, color),
    rule(s, w, [s.bl, s.br], status, [], color, true),
  ]
}

/** The legend lists only the sigils the focused pane is actually showing. */
function legend(pane: Pane, w: number, cols: Column[]): Line[] {
  const present: Line = [{ t: ' ' }]
  for (const slot of ['health', 'move', 'flag'] as const) {
    const used = new Set(pane.rows.map((r) => r[slot]))
    const table = SIGILS[slot] as Record<string, readonly [string, string]>
    const tones = { health: HEALTH_TONE, move: MOVE_TONE, flag: FLAG_TONE }[slot] as Record<
      string,
      string | undefined
    >
    const keys = Object.keys(table).filter((k) => used.has(k as never) && table[k]![1])
    if (!keys.length) continue
    if (present.length > 1) present.push({ t: ' │ ', c: C.frame })
    for (const [i, k] of keys.entries()) {
      present.push({ t: `${i ? ' ' : ''}${table[k]![0]}`, c: tones[k] })
      present.push({ t: ` ${table[k]![1]}`, c: C.muted })
    }
  }
  const icons: Line = [{ t: ' ' }]
  for (const [i, col] of cols.entries()) {
    icons.push({ t: `${i ? '  ' : ''}${col.icon}`, c: C[pane.id] })
    icons.push({ t: ` ${col.label}`, c: C.muted })
  }
  return [fit(present, w), fit(icons, w)]
}

// ---------------------------------------------------------------- app

function useSize() {
  const { stdout } = useStdout()
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 })
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows })
    stdout.on('resize', onResize)
    return () => void stdout.off('resize', onResize)
  }, [stdout])
  return size
}

async function refresh(ecosystems: Ecosystem[]): Promise<void> {
  for (const ecosystem of ecosystems) {
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [BIN, 'refresh', '--only', ecosystem], {
        stdio: 'ignore',
      })
      child.on('exit', () => resolve())
      child.on('error', () => resolve())
    })
  }
}

export function App() {
  const { exit } = useApp()
  const { columns, rows } = useSize()
  const [board, setBoard] = useState<Board>(() => buildBoard())
  const [focus, setFocus] = useState(0)
  const [cursors, setCursors] = useState<Record<PaneId, number>>({
    github: 0,
    registries: 0,
    extensions: 0,
  })
  const [detailAt, setDetailAt] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const pane = board.panes[focus]!
  const cursor = Math.min(cursors[pane.id], Math.max(0, pane.rows.length - 1))
  const row = pane.rows[cursor]

  const move = (by: number) =>
    setCursors((c) => ({
      ...c,
      [pane.id]: Math.max(0, Math.min(pane.rows.length - 1, cursor + by)),
    }))

  const runRefresh = (ecosystems: Ecosystem[]) => {
    if (busy) return
    setBusy(ecosystems.join(' + '))
    void refresh(ecosystems).then(() => {
      setBoard(buildBoard())
      setBusy(null)
    })
  }

  useInput((input, key) => {
    if (input === 'q') return exit()
    if (detailAt !== null) {
      if (key.escape || key.return || key.leftArrow || input === 'h') return setDetailAt(null)
      if (input === 'j' || key.downArrow) return setDetailAt(detailAt + 1)
      if (input === 'k' || key.upArrow) return setDetailAt(Math.max(0, detailAt - 1))
      return
    }
    const count = board.panes.length
    if (key.tab && key.shift) return setFocus((focus + count - 1) % count)
    if (key.tab || input === 'l' || key.rightArrow) return setFocus((focus + 1) % count)
    if (input === 'h' || key.leftArrow) return setFocus((focus + count - 1) % count)
    if (/^[1-9]$/.test(input) && Number(input) <= count) return setFocus(Number(input) - 1)
    if (input === 'j' || key.downArrow) return move(1)
    if (input === 'k' || key.upArrow) return move(-1)
    if (key.pageDown) return move(10)
    if (key.pageUp) return move(-10)
    if (input === 'g') return move(-Infinity)
    if (input === 'G') return move(Infinity)
    if (key.return && row) return setDetailAt(0)
    if (input === 'o' && row?.targets[0]) {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
      spawn(opener, [row.targets[0].url], { detached: true, stdio: 'ignore' }).unref()
    }
    if (input === 'r') return runRefresh(pane.ecosystems)
    if (input === 'R') return runRefresh(board.panes.flatMap((p) => p.ecosystems))
  })

  const lines = useMemo(() => {
    const w = columns
    const height = rows - 1
    const status: Line = busy
      ? [{ t: `${ICON.clock} refreshing ${busy}…`, c: C.warn }]
      : [
          { t: '⇥', c: C.accent },
          { t: ' pane ', c: C.muted },
          { t: 'jk', c: C.accent },
          { t: ' row ', c: C.muted },
          { t: '⏎', c: C.accent },
          { t: ' detail ', c: C.muted },
          { t: 'o', c: C.accent },
          { t: ' open ', c: C.muted },
          { t: 'r', c: C.accent },
          { t: ` refresh ${pane.ecosystems.join('+')} `, c: C.muted },
          { t: 'q', c: C.accent },
        ]
    const top = summaryBar(board, w, focus, status)
    const bodyH = Math.max(6, height - top.length - 2)
    const now = board.now

    const draw = (i: number, pw: number, ph: number): Line[] => {
      const p = board.panes[i]!
      const focused = i === focus
      if (focused && detailAt !== null && row) return detail(p, row, pw, ph, detailAt, now)
      const at = Math.min(cursors[p.id], Math.max(0, p.rows.length - 1))
      return ledger({ pane: p, w: pw, h: ph, focused, cursor: focused ? cursor : at, now })
    }

    let body: Line[]
    let visibleCols = pane.columns
    if (w >= WIDE) {
      // GitHub holds every repo, so it takes the tall left column; the two store panes
      // share the right, the extension pane sized to its handful of listings.
      const leftW = Math.floor(w * 0.46)
      const rightW = w - leftW
      const extH = Math.min(board.panes[2]!.rows.length + 4, Math.floor(bodyH / 2))
      const left = draw(0, leftW, bodyH)
      const right = [...draw(1, rightW, bodyH - extH), ...draw(2, rightW, extH)]
      body = left.map((l, i) => [...l, ...(right[i] ?? [])])
      visibleCols = layout(pane, (focus === 0 ? leftW : rightW) - 2).columns
    } else {
      body = []
      board.panes.forEach((p, i) => {
        if (i === focus) body.push(...draw(i, w, bodyH - (board.panes.length - 1)))
        else body.push(folded(p, w, i, now))
      })
      visibleCols = layout(pane, w - 2).columns
    }
    return [...top, ...body, ...legend(pane, w, visibleCols)].slice(0, height)
  }, [board, columns, rows, focus, cursor, cursors, detailAt, busy, pane, row])

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line.map((seg, j) => (
            <Text
              key={j}
              color={seg.c}
              bold={seg.b}
              backgroundColor={colorless ? undefined : seg.bg}
            >
              {seg.t}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}
