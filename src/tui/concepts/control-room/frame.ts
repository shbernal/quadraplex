import { compactNumber, formatDate } from '../../../core/format.ts'
import type { Target } from '../../../core/types.ts'
import { projectItems, type Project } from '../../model.ts'
import { age, delta, STATUS, type Board, type Pane, type Row } from './board.ts'
import { C, fit, G, join, overlay, padLeft, paint, seg, width, type Line } from './cells.ts'

/**
 * Pure layout: board plus UI state in, a grid of exactly `rows` lines of `cols` cells out.
 * Wide terminals get GitHub on the left and the two store panes stacked on the right;
 * narrow ones stack all three and fold the panes out of focus down to their top border,
 * which still carries the gauges.
 */

export type Ui = {
  pane: number
  cursors: number[]
  scrolls: number[]
  overlay: 'legend' | 'detail' | null
  busy: string | null
}

const HEAVY = { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', l: '┫', r: '┣', thumb: '█' }
const ROUND = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', l: '┤', r: '├', thumb: '┃' }
const DOUBLE = { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', l: '╡', r: '╞', thumb: '█' }
type Border = typeof HEAVY

/** A border line with chips inset at the left and the right, rule filling the middle. */
function rule(
  w: number,
  b: Border,
  ends: [string, string],
  left: Line[],
  right: Line[],
  color: string | undefined,
): Line {
  const chip = (l: Line): Line => [seg(b.l, color), seg(' '), ...l, seg(' '), seg(b.r, color)]
  const lead = [seg(ends[0] + b.h, color)]
  const tail = [seg(b.h + ends[1], color)]
  let rights = right.filter((r) => width(r) > 0)
  const build = () => {
    const l = join(left.map(chip), [seg(b.h, color)])
    const r = join(rights.map(chip), [seg(b.h, color)])
    const fill = w - width(lead) - width(tail) - width(l) - width(r)
    return { l, r, fill }
  }
  let parts = build()
  while (parts.fill < 1 && rights.length) {
    rights = rights.slice(1)
    parts = build()
  }
  const fill = Math.max(0, parts.fill)
  return fit([...lead, ...parts.l, seg(b.h.repeat(fill), color), ...parts.r, ...tail], w)
}

/** Column widths for a pane, dropping the least important columns until the name fits. */
function layoutColumns(pane: Pane, inner: number) {
  const MIN_NAME = 10
  let cols = pane.columns
  const used = () => cols.reduce((n, c) => n + c.width + 1, 0)
  while (inner - 3 - used() < MIN_NAME && cols.length) {
    const weakest = cols.reduce((a, c) => (c.pri < a.pri ? c : a))
    cols = cols.filter((c) => c !== weakest)
  }
  // Slack widens the gaps up to three cells before it widens the name, so numbers stay
  // near the name they belong to instead of drifting to the far border.
  const longest = Math.max(4, ...pane.rows.map((r) => r.name.length)) + 1
  const avail = inner - 3 - used()
  const spare = Math.max(0, avail - longest)
  const gap = 1 + Math.min(2, cols.length ? Math.floor(spare / cols.length) : 0)
  return { cols, gap, name: Math.max(1, avail - (gap - 1) * cols.length) }
}

function rowLine(pane: Pane, row: Row, inner: number, cursor: boolean, linked: boolean): Line {
  const { cols, name, gap } = layoutColumns(pane, inner)
  const st = STATUS[row.status]
  const gutter = cursor ? seg('▌', pane.color) : linked ? seg('◆', C.accent) : seg(' ')
  const cells = cols.map((c) =>
    c.left ? fit(c.cell(row), c.width) : padLeft(c.cell(row), c.width),
  )
  const line = [
    gutter,
    seg(st.glyph, st.color),
    seg(' '),
    ...fit([seg(row.name, cursor ? C.text : undefined, { b: cursor })], name),
    ...cells.flatMap((c) => [seg(' '.repeat(gap)), ...c]),
  ]
  return paint(fit(line, inner), cursor ? C.cursor : linked ? C.linked : undefined)
}

function headLine(pane: Pane, inner: number): Line {
  const { cols, name, gap } = layoutColumns(pane, inner)
  const label = [seg('   '), ...fit([seg(pane.icon, C.muted)], name)]
  const head = (c: (typeof cols)[number]) =>
    c.left ? fit(c.head, c.width) : padLeft(c.head, c.width)
  return fit([...label, ...cols.flatMap((c) => [seg(' '.repeat(gap)), ...head(c)])], inner)
}

function freshness(pane: Pane, now: number): Line[] {
  const over = pane.asOf ? now - Date.parse(pane.asOf) > pane.ttl : true
  const ttl = `${Math.round(pane.ttl / 3_600_000)}h`
  const chips: Line[] = [
    [seg(`${G.clock} ${age(pane.asOf, now)}`, over ? C.warn : C.up), seg(`/${ttl}`, C.muted)],
  ]
  if (pane.stale) chips.push([seg(`${G.hourglass} ${pane.stale}`, C.warn)])
  return chips
}

export function paneLines(
  pane: Pane,
  w: number,
  h: number,
  focused: boolean,
  ui: Ui,
  selected: string | null,
  now: number,
  index: number,
): Line[] {
  const b = focused ? HEAVY : ROUND
  const color = focused ? pane.color : C.muted
  const title: Line = focused
    ? [seg(` ${pane.icon} ${pane.title} `, C.ink, { bg: pane.color, b: true })]
    : [seg(`${pane.icon} ${pane.title}`, pane.color, { b: true })]
  const key: Line = [seg(String(index + 1), C.muted)]
  if (h <= 1) {
    return [rule(w, ROUND, ['╶', '╴'], [key, title, pane.summary], freshness(pane, now), C.muted)]
  }
  const inner = w - 2
  const body = h - 3
  const cursor = ui.cursors[index] ?? 0
  let scroll = ui.scrolls[index] ?? 0
  if (cursor < scroll) scroll = cursor
  if (cursor >= scroll + body) scroll = cursor - body + 1
  scroll = Math.max(0, Math.min(scroll, Math.max(0, pane.rows.length - body)))
  ui.scrolls[index] = scroll

  const top = rule(w, b, [b.tl, b.tr], [title], [pane.summary, key], color)
  const lines: Line[] = [top, [seg(b.v, color), ...headLine(pane, inner), seg(b.v, color)]]
  // The thumb rides the right border, sized to the share of rows on screen.
  const total = pane.rows.length
  const thumb = total > body ? Math.max(1, Math.round((body / total) * body)) : 0
  const thumbAt = total > body ? Math.round((scroll / (total - body)) * (body - thumb)) : 0
  for (let i = 0; i < body; i++) {
    const row = pane.rows[scroll + i]
    const right =
      thumb && i >= thumbAt && i < thumbAt + thumb ? seg(b.thumb, color) : seg(b.v, color)
    const content = row
      ? rowLine(
          pane,
          row,
          inner,
          focused && scroll + i === cursor,
          !focused && row.key === selected,
        )
      : i === 0
        ? fit([seg('  nothing here', C.muted, { i: true })], inner)
        : fit([], inner)
    lines.push([seg(b.v, color), ...content, right])
  }
  const position: Line = total
    ? [seg(`${Math.min(cursor + 1, total)}/${total}`, focused ? C.text : C.muted)]
    : []
  lines.push(rule(w, b, [b.bl, b.br], freshness(pane, now), [position], color))
  return lines
}

/** Splits `total` rows among panes, giving the focused one what the others do not need. */
function stackHeights(want: number[], total: number, focus: number): number[] {
  const heights = want.map(() => 1)
  let free = total - want.length
  const grow = (i: number, n: number) => {
    const add = Math.max(0, Math.min(n, free))
    heights[i]! += add
    free -= add
  }
  const others = want.map((_, i) => i).filter((i) => i !== focus)
  others.sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus))
  // The focused pane is guaranteed a usable view, then any pane that fits whole is drawn
  // whole, then the focused pane grows to its natural size, and only then do the others
  // get a partial view. Whatever is left pads the focused pane.
  const floor = Math.min(want[focus]!, 12) - 1
  grow(focus, floor)
  for (const i of others) if (free >= want[i]! - 1) grow(i, want[i]! - 1)
  grow(focus, want[focus]! - 1 - floor)
  for (const i of others) if (heights[i] === 1 && free >= 4) grow(i, want[i]! - 1)
  grow(focus, free)
  return heights
}

function header(board: Board, cols: number, ui: Ui): Line {
  const brand: Line = [seg(` ${G.radar} QUADRAPLEX `, C.ink, { bg: C.accent, b: true })]
  const right: Line = ui.busy
    ? [seg(`${G.sync} ${ui.busy} `, C.warn, { b: true })]
    : [
        seg(`Δ ${board.baselineAt ? formatDate(board.baselineAt) : 'new'}`, C.muted),
        seg('  '),
        seg(`${G.sync} ${age(board.newest, board.now)}`, C.muted),
        seg(' '),
      ]
  const lamps: Line = board.panes.flatMap((p, i) => {
    const st = p.stale ? C.warn : C.up
    return [
      seg(' '),
      seg(i === ui.pane ? '◉ ' : '○ ', i === ui.pane ? p.color : C.muted),
      seg(`${p.icon} `, p.color),
      seg(String(p.rows.length), C.text),
      seg(p.stale ? ` ${G.hourglass} ` : '  ', st),
    ]
  })
  const mid = cols - width(brand) - width(right)
  return [...brand, ...fit(lamps, Math.max(0, mid)), ...right]
}

function footer(cols: number): Line {
  const keys: [string, string][] = [
    ['⇥', 'pane'],
    ['jk', 'row'],
    ['⏎', 'detail'],
    ['o', 'open'],
    ['r', 'refresh'],
    ['?', 'legend'],
    ['q', 'quit'],
  ]
  const line = [
    seg(' '),
    ...join(
      keys.map(([k, label]) => [seg(k, C.accent, { b: true }), seg(` ${label}`, C.muted)]),
      [seg('  ·  ', C.muted)],
    ),
  ]
  return fit(line, cols)
}

// ---------------------------------------------------------------- overlays

function box(title: Line, body: Line[], w: number, footerChips: Line[]): Line[] {
  const b = DOUBLE
  const inner = w - 4
  return [
    rule(w, b, [b.tl, b.tr], [title], [], C.accent),
    ...body.map((l) => [seg(b.v + ' ', C.accent), ...fit(l, inner), seg(' ' + b.v, C.accent)]),
    rule(w, b, [b.bl, b.br], [], footerChips, C.accent),
  ]
}

const LEGEND: [string, Line[]][] = [
  [
    'status',
    [
      [
        seg('●', C.up),
        seg(' rose  '),
        seg('●', C.down),
        seg(' fell  '),
        seg('·', C.muted),
        seg(' quiet'),
      ],
      [seg('◌', C.muted), seg(' new, no baseline yet')],
      [seg(G.hourglass, C.warn), seg(' past TTL  '), seg('✗', C.down), seg(' fetch failed')],
      [
        seg('▲3', C.up),
        seg(' '),
        seg('▼3', C.down),
        seg(' '),
        seg('·', C.muted),
        seg(' held  '),
        seg('new', C.muted, { i: true }),
        seg(' no baseline'),
      ],
      [seg('?', C.muted), seg(' not published')],
    ],
  ],
  [
    `${G.github} github`,
    [
      [seg(G.star, C.star), seg(' stars  '), seg(G.fork, C.muted), seg(' forks')],
      [seg(G.issue, C.issue), seg(' issues  '), seg(G.pr, C.pr), seg(' pull requests')],
      [seg(G.commit, C.muted), seg(' last push  '), seg('⇡', C.accent), seg(' unreleased push')],
    ],
  ],
  [
    `${G.npm} registries`,
    [
      [
        seg(G.npm, C.npm),
        seg(' npm  '),
        seg(G.pypi, C.pypi),
        seg(' PyPI  '),
        seg(G.tag, C.muted),
        seg(' version'),
      ],
      [seg(G.download, C.text), seg(' downloads/wk  '), seg(G.calendar, C.muted), seg(' /month')],
      [seg(G.rocket, C.muted), seg(' last publish  '), seg('†', C.down), seg(' deprecated')],
    ],
  ],
  [
    `${G.puzzle} extensions`,
    [
      [
        seg(G.chrome, C.chrome),
        seg(' Chrome  '),
        seg(G.firefox, C.firefox),
        seg(' Firefox  '),
        seg(G.users, C.muted),
        seg(' users'),
      ],
      [seg('≈1,000', C.chrome), seg(' Google bucket')],
      [seg('★', C.star), seg(' rating')],
      [seg('1.0≠1.1', C.warn), seg(' stores disagree')],
    ],
  ],
  [
    'frame',
    [
      [seg('┏━┓', C.accent), seg(' focused pane  '), seg('◆', C.accent), seg(' same project')],
      [seg(G.clock, C.up), seg(' oldest fetch / TTL  '), seg('█', C.muted), seg(' scroll')],
    ],
  ],
]

function legend(cols: number, rows: number): Line[] {
  const two = cols >= 76
  const blocks = LEGEND.map(([title, lines]) => [
    [seg(title.toUpperCase(), C.accent, { b: true })],
    ...lines,
  ])
  let body: Line[]
  if (two) {
    const colW = Math.floor((Math.min(cols - 4, 96) - 4 - 3) / 2)
    const left = [...blocks[0]!, [], ...blocks[1]!]
    const right = [...blocks[2]!, [], ...blocks[3]!, [], ...blocks[4]!]
    body = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [
      ...fit(left[i] ?? [], colW),
      seg(' │ ', C.muted),
      ...fit(right[i] ?? [], colW),
    ])
  } else {
    body = blocks.flatMap((b, i) => (i ? [[], ...b] : b))
  }
  const w = two ? Math.min(cols - 4, 96) : Math.min(cols - 2, 60)
  const fitBody = body.slice(0, rows - 2)
  return box([seg(`${G.info} LEGEND`, C.accent, { b: true })], fitBody, w, [[seg('esc', C.muted)]])
}

const n = (v: unknown) => (typeof v === 'number' ? compactNumber(v) : '?')

function targetLine(t: Target, now: number): Line {
  const m = t.metrics
  const d = (k: string) => delta(t.deltas ? (t.deltas[k] ?? null) : null)
  const v = typeof m.version === 'string' ? [seg(` ${G.tag} ${m.version}`, C.accent)] : []
  const pub =
    typeof m.lastPublish === 'string'
      ? [seg(`  ${G.rocket} ${age(m.lastPublish, now)}`, C.muted)]
      : []
  switch (t.ecosystem) {
    case 'github':
      return [
        seg(G.github, C.github),
        seg(` ${G.star} ${n(m.stars)} `, C.star),
        ...d('stars'),
        seg(`  ${G.fork} ${n(m.forks)}`, C.muted),
        seg(`  ${G.issue} ${n(m.openIssues)}`, C.issue),
        seg(`  ${G.pr} ${n(m.openPRs)}`, C.pr),
        seg(`  ${G.commit} ${age(m.lastPush as string, now)}`, C.muted),
      ]
    case 'npm':
    case 'pypi':
      return [
        seg(t.ecosystem === 'npm' ? G.npm : G.pypi, t.ecosystem === 'npm' ? C.npm : C.pypi),
        ...v,
        seg(`  ${G.download} ${n(m.downloadsWeek)} `, C.text),
        ...d('downloadsWeek'),
        seg(`  ${G.calendar} ${n(m.downloadsMonth)}`, C.muted),
        ...pub,
      ]
    case 'amo':
      return [
        seg(G.firefox, C.firefox),
        ...v,
        seg(`  ${G.users} ${n(m.users)} `, C.text),
        ...d('users'),
        seg(`  ★ ${typeof m.rating === 'number' ? m.rating.toFixed(1) : '·'}`, C.star),
        ...pub,
      ]
    default:
      return [
        seg(G.chrome, C.chrome),
        ...v,
        seg(`  ${G.users} ${typeof m.users === 'string' ? `≈${m.users}` : '?'}`, C.text),
        seg(`  ★ ${typeof m.rating === 'number' ? m.rating.toFixed(1) : '·'}`, C.star),
        ...pub,
      ]
  }
}

function detail(project: Project, now: number, cols: number, rows: number): Line[] {
  const body: Line[] = []
  for (const t of project.targets) {
    body.push([seg(t.id, C.muted)])
    body.push([seg('  '), ...targetLine(t, now)])
    for (const e of t.errors ?? []) body.push([seg(`  ✗ ${e}`, C.down)])
  }
  const drift = project.drift
  if (drift.versions || drift.unreleased) body.push([])
  if (drift.versions) {
    body.push([
      seg('≠ ', C.warn),
      seg(drift.versions.map((x) => `${x.ecosystem} ${x.version}`).join('  vs  ')),
    ])
  }
  if (drift.unreleased) {
    body.push([
      seg('⇡ ', C.accent),
      seg(
        `pushed ${age(drift.unreleased.pushedAt, now)} ago, released ${age(drift.unreleased.publishedAt, now)} ago`,
      ),
    ])
  }
  const items = projectItems(project)
  if (items.length) {
    body.push([])
    for (const item of items) {
      body.push([
        seg(item.kind === 'pr' ? G.pr : G.issue, item.kind === 'pr' ? C.pr : C.issue),
        seg(` #${item.number} `, C.muted),
        seg(`${item.author} ${age(item.createdAt, now)}  `, C.muted),
        seg(item.title),
      ])
    }
  }
  const w = Math.min(cols - 4, 88)
  const room = rows - 4
  const shown =
    body.length > room
      ? [...body.slice(0, room - 1), [seg(`+${body.length - room + 1} more`, C.muted)]]
      : body
  return box([seg(` ${project.name} `, C.ink, { bg: C.accent, b: true })], shown, w, [
    [seg('o', C.accent), seg(' open  '), seg('esc', C.accent), seg(' close')],
  ])
}

function splice(base: Line[], over: Line[], cols: number, rows: number): Line[] {
  const x = Math.max(0, Math.floor((cols - width(over[0] ?? [])) / 2))
  const y = Math.max(1, Math.floor((rows - over.length) / 2))
  return base.map((line, i) => {
    const o = over[i - y]
    return o ? overlay(line, x, o) : line
  })
}

/**
 * The systems panel: one lamp per store, the only place the five sources are read apart
 * rather than folded into a domain. Not navigable, it fills spare room on wide screens.
 */
function sourcesLines(board: Board, w: number, h: number): Line[] {
  const b = ROUND
  const color = C.muted
  const top = rule(
    w,
    b,
    [b.tl, b.tr],
    [[seg(`${G.pulse} SOURCES`, C.accent, { b: true })]],
    [[seg('R', C.muted), seg(' all', C.muted)]],
    color,
  )
  const lines: Line[] = [top]
  for (const s of board.sources) {
    const over = !s.asOf || board.now - Date.parse(s.asOf) > s.ttl
    const lamp = s.errors ? seg('✗', C.down) : over ? seg('●', C.warn) : seg('●', C.up)
    const ttl = `${Math.round(s.ttl / 3_600_000)}h`
    const row: Line = [
      seg(' '),
      lamp,
      seg(' '),
      seg(s.icon, s.color),
      seg(` ${s.ecosystem.padEnd(6)}`, C.text),
      ...padLeft([seg(String(s.targets), C.text)], 3),
      seg('   '),
      seg(`${G.clock} `, over ? C.warn : C.up),
      ...fit([seg(age(s.asOf, board.now), over ? C.warn : C.text), seg(`/${ttl}`, C.muted)], 8),
      seg(`${G.hourglass} ${s.stale}`, s.stale ? C.warn : C.muted),
      seg('   '),
      seg(`✗ ${s.errors}`, s.errors ? C.down : C.muted),
      seg('   '),
      seg(`◌ ${s.fresh}`, C.muted),
    ]
    lines.push([seg(b.v, color), ...fit(row, w - 2), seg(b.v, color)])
  }
  while (lines.length < h - 1) lines.push([seg(b.v, color), ...fit([], w - 2), seg(b.v, color)])
  const base: Line = board.baselineAt
    ? [seg('Δ', C.muted), seg(` since ${formatDate(board.baselineAt)}`, C.text)]
    : [seg('Δ new', C.muted)]
  lines.push(rule(w, b, [b.bl, b.br], [base], [], color))
  return lines.slice(0, h)
}

const natural = (pane: Pane) => Math.max(4, pane.rows.length + 3)

// ---------------------------------------------------------------- frame

export function selectedRow(board: Board, ui: Ui): Row | undefined {
  return board.panes[ui.pane]?.rows[ui.cursors[ui.pane] ?? 0]
}

export function frame(board: Board, ui: Ui, cols: number, rows: number): Line[] {
  const body = rows - 2
  const selected = selectedRow(board, ui)?.key ?? null
  const { panes, now } = board
  const draw = (i: number, w: number, h: number) =>
    paneLines(panes[i]!, w, h, i === ui.pane, ui, selected, now, i)
  let lines: Line[]
  if (cols >= 110) {
    // GitHub and the extension stores share the left column, the registries take the
    // right whole: those are the two halves the portfolio actually splits into by count.
    const left = Math.floor(cols / 2)
    const right = cols - left
    const pair = [panes[0]!, panes[2]!]
    const heights = stackHeights(pair.map(natural), body, ui.pane === 2 ? 1 : 0)
    const leftCol = [draw(0, left, heights[0]!), draw(2, left, heights[1]!)].flat()
    const spare = body - natural(panes[1]!)
    const systems = board.sources.length + 2
    const rightCol =
      spare >= systems
        ? [draw(1, right, body - systems), sourcesLines(board, right, systems)].flat()
        : draw(1, right, body)
    lines = leftCol.map((l, i) => [...l, ...(rightCol[i] ?? fit([], right))])
  } else {
    const heights = stackHeights(panes.map(natural), body, ui.pane)
    lines = panes.flatMap((_, i) => draw(i, cols, heights[i]!))
  }
  let out = [header(board, cols, ui), ...lines.slice(0, body), footer(cols)]
  while (out.length < rows) out.splice(out.length - 1, 0, fit([], cols))
  if (ui.overlay === 'legend') out = splice(out, legend(cols, rows), cols, rows)
  const row = selectedRow(board, ui)
  if (ui.overlay === 'detail' && row)
    out = splice(out, detail(row.project, now, cols, rows), cols, rows)
  return out.map((l) => fit(l, cols))
}
