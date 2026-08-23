import { formatDate } from '../core/format.ts'
import { detailBox, itemBox, type Inspect } from './detail.ts'
import {
  age,
  statusMark,
  type Board,
  type Pane,
  type PaneId,
  type Row,
  type View,
} from './board.ts'
import {
  box,
  C,
  fit,
  G,
  HEAVY,
  join,
  overlay,
  padLeft,
  paint,
  ROUND,
  rule,
  seg,
  width,
  type Line,
} from './cells.ts'

/**
 * Pure layout: board plus UI state in, a grid of exactly `rows` lines of `cols` cells out.
 * Wide terminals put the registries on the right and the other panes stacked on the left;
 * narrow ones stack every pane and fold those out of focus down to their top border,
 * which still carries the gauges. Only the panes the config names are on the board.
 */

export type Ui = {
  /** Index into the board's panes. */
  pane: number
  /** Per pane id, so a pane leaving the board does not shift the others' positions. */
  cursors: Partial<Record<PaneId, number>>
  scrolls: Partial<Record<PaneId, number>>
  overlay: 'legend' | 'detail' | 'item' | null
  /** The detail cursor, over targets then open items. */
  focus: number
  /** How far an open issue or PR body is scrolled. */
  offset: number
  busy: string | null
  /** What went wrong in the last refresh, kept until the next one. */
  notice: string | null
  view: View
  /** The filter prompt is open, and every key is text until enter or escape. */
  typing: boolean
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
  const st = statusMark(row.status)
  const gutter = cursor ? seg('▌', pane.color) : linked ? seg('▏', C.accent) : seg(' ')
  const cells = cols.map((c) =>
    c.left ? fit(c.cell(row), c.width) : padLeft(c.cell(row), c.width),
  )
  const line = [
    gutter,
    seg(st.glyph, st.color),
    seg(' '),
    ...fit([seg(row.name, cursor ? C.text : undefined, { b: cursor })], name),
    ...cells.flatMap((c) => [seg(' '.repeat(gap))].concat(c)),
  ]
  return paint(fit(line, inner), cursor ? C.cursor : linked ? C.linked : undefined)
}

function headLine(pane: Pane, inner: number): Line {
  const { cols, name, gap } = layoutColumns(pane, inner)
  const label = [seg('   '), ...fit([seg(pane.icon, C.muted)], name)]
  const head = (c: (typeof cols)[number]) =>
    c.left ? fit(c.head, c.width) : padLeft(c.head, c.width)
  return fit([...label, ...cols.flatMap((c) => [seg(' '.repeat(gap))].concat(head(c)))], inner)
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

function paneLines(
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
  const cursor = ui.cursors[pane.id] ?? 0
  let scroll = ui.scrolls[pane.id] ?? 0
  if (cursor < scroll) scroll = cursor
  if (cursor >= scroll + body) scroll = cursor - body + 1
  scroll = Math.max(0, Math.min(scroll, Math.max(0, pane.rows.length - body)))
  ui.scrolls[pane.id] = scroll

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
        ? fit(
            [
              seg(ui.view.query ? '  no match' : '  nothing here', C.muted, {
                i: true,
              }),
            ],
            inner,
          )
        : fit([], inner)
    lines.push([seg(b.v, color), ...content, right])
  }
  const position: Line = total
    ? [seg(`${Math.min(cursor + 1, total)}/${total}`, focused ? C.text : C.muted)]
    : []
  const sort = ui.view.sorts[pane.id] ?? 'default'
  const sorted: Line = sort === 'default' ? [] : [seg(`s ${sort}`, C.accent)]
  lines.push(rule(w, b, [b.bl, b.br], freshness(pane, now), [sorted, position], color))
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
  const brand: Line = [seg(' QUADRAPLEX ', C.ink, { bg: C.accent, b: true })]
  const status: Line = ui.busy
    ? [seg(`${G.sync} ${ui.busy} `, C.warn, { b: true })]
    : ui.notice
      ? [seg(`✗ ${ui.notice} `, C.down, { b: true })]
      : ui.view.query && !ui.typing
        ? [seg(`/ ${ui.view.query} `, C.accent, { b: true })]
        : [
            seg(`Δ ${board.baselineAt ? formatDate(board.baselineAt) : 'new'}`, C.muted),
            seg('  '),
            seg(`${G.sync} ${age(board.newest, board.now)}`, C.muted),
            seg(' '),
          ]
  // A long refresh notice gives up its tail before the brand gives up anything.
  const right = fit(status, Math.min(width(status), cols - width(brand)))
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

function footer(cols: number, ui: Ui): Line {
  if (ui.typing) {
    return fit(
      [
        seg(' / ', C.accent, { b: true }),
        seg(ui.view.query, C.text),
        seg('▏', C.accent),
        seg('   ⏎ keep  esc cancel', C.muted),
      ],
      cols,
    )
  }
  const keys: [string, string][] = [
    ['⇥', 'pane'],
    ['jk', 'row'],
    ['⏎', 'detail'],
    ['o', 'open'],
    ['/', 'filter'],
    ['s', 'sort'],
    ['r', 'refresh'],
    ['?', 'keys'],
    ['q', 'quit'],
  ]
  const chips = keys.map(([k, label]) => [seg(k, C.accent, { b: true }), seg(` ${label}`, C.muted)])
  // The separator gives way before any key does.
  for (const gap of ['  ·  ', '  ', ' ']) {
    const line = [seg(' '), ...join(chips, [seg(gap, C.muted)])]
    if (width(line) <= cols) return fit(line, cols)
  }
  return fit([seg(' '), ...join(chips, [seg(' ')])], cols)
}

// ---------------------------------------------------------------- overlays

/** Built per call, because the glyph table is chosen at startup. */
const legendBlocks = (panes: number): [string, Line[]][] => [
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
      [
        seg(G.commit, C.muted),
        seg(' last push  '),
        seg('⇡', C.unreleased),
        seg(' commits since release'),
      ],
      [seg(G.skill, C.accent), seg(' agent skill installs')],
    ],
  ],
  [
    `${G.package} registries`,
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
      [seg('1.0≠1.1', C.warn), seg(' ecosystems disagree')],
    ],
  ],
  [
    `${G.skill} skills`,
    [
      [
        seg(G.skill, C.accent),
        seg(' skills.sh  '),
        seg(G.clawhub, C.clawhub),
        seg(' ClawHub  '),
        seg('Σ', C.text),
        seg(' installs, both'),
      ],
      [seg('Δ', C.muted), seg(' ClawHub only, skills.sh has no history')],
    ],
  ],
  [
    'keys',
    [
      [seg(`⇥ hl 1-${panes}`, C.accent), seg(' pane  '), seg('jk g G', C.accent), seg(' row')],
      [seg('⏎', C.accent), seg(' detail, read  '), seg('o', C.accent), seg(' open in browser')],
      [seg('/', C.accent), seg(' filter all panes  '), seg('s', C.accent), seg(' sort pane')],
      [seg('c', C.accent), seg(' clear filter and sorts  '), seg('a', C.accent), seg(' accounts')],
      [seg('r', C.accent), seg(' refresh pane  '), seg('R', C.accent), seg(' everything')],
      [seg('esc', C.accent), seg(' back  '), seg('q', C.accent), seg(' quit')],
    ],
  ],
  [
    'frame',
    [
      [seg('┏━┓', C.accent), seg(' focused pane  '), seg('▏', C.accent), seg(' same project')],
      [seg(G.clock, C.up), seg(' oldest fetch / TTL  '), seg('█', C.muted), seg(' scroll')],
    ],
  ],
]

function legend(cols: number, rows: number, panes: number): Line[] {
  const two = cols >= 76
  const blocks = legendBlocks(panes).map(([title, lines]) =>
    [[seg(title.toUpperCase(), C.accent, { b: true })]].concat(lines),
  )
  let body: Line[]
  if (two) {
    const colW = Math.floor((Math.min(cols - 4, 96) - 4 - 3) / 2)
    const left = [...blocks[0]!, [], ...blocks[1]!, [], ...blocks[5]!]
    const right = [...blocks[2]!, [], ...blocks[3]!, [], ...blocks[4]!, [], ...blocks[6]!]
    body = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [
      ...fit(left[i] ?? [], colW),
      seg(' │ ', C.muted),
      ...fit(right[i] ?? [], colW),
    ])
  } else {
    body = blocks.flatMap((b, i) => (i ? [[] as Line].concat(b) : b))
  }
  const w = two ? Math.min(cols - 4, 96) : Math.min(cols - 2, 60)
  const fitBody = body.slice(0, rows - 2)
  return box([seg(`${G.info} LEGEND`, C.accent, { b: true })], fitBody, w, [[seg('esc', C.muted)]])
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
      seg(` ${s.ecosystem.padEnd(9)}`, C.text),
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
  const pane = board.panes[ui.pane]
  return pane?.rows[ui.cursors[pane.id] ?? 0]
}

/** `inspected` is the project the detail and item overlays draw, read once per opening. */
export function frame(
  board: Board,
  ui: Ui,
  cols: number,
  rows: number,
  inspected?: Inspect,
): Line[] {
  const body = rows - 2
  const selected = selectedRow(board, ui)?.key ?? null
  const { panes, now } = board
  /** Panes stacked in one column of `h` rows, the systems panel under them when it fits. */
  const column = (indices: number[], w: number, h: number, systems: boolean): Line[] => {
    const size = board.sources.length + 2
    const spare = h - indices.reduce((n, i) => n + natural(panes[i]!), 0)
    const room = systems && spare >= size ? h - size : h
    const at = indices.indexOf(ui.pane)
    const heights = stackHeights(
      indices.map((i) => natural(panes[i]!)),
      room,
      at >= 0 ? at : 0,
    )
    const drawn = indices.flatMap((i, k) =>
      paneLines(panes[i]!, w, heights[k]!, i === ui.pane, ui, selected, now, i),
    )
    return room < h ? drawn.concat(sourcesLines(board, w, size)) : drawn
  }
  const all = panes.map((_, i) => i)
  let lines: Line[]
  if (!panes.length) {
    lines = [
      fit(
        [
          seg('  no accounts are set up, run "qplex init"', C.muted, {
            i: true,
          }),
        ],
        cols,
      ),
    ]
  } else if (cols >= 110 && panes.length > 1) {
    // The registries take the right column whole and the rest share the left: those are
    // the two halves the portfolio actually splits into by count. Without registries the
    // last pane moves right instead.
    const split = panes.findIndex((p) => p.id === 'registries')
    const right = split >= 0 ? [split] : [all.at(-1)!]
    const left = all.filter((i) => !right.includes(i))
    const lw = Math.floor(cols / 2)
    const leftCol = column(left, lw, body, false)
    const rightCol = column(right, cols - lw, body, true)
    lines = leftCol.map((l, i) => l.concat(rightCol[i] ?? fit([], cols - lw)))
  } else {
    lines = column(all, cols, body, cols >= 110)
  }
  let out = [header(board, cols, ui), ...lines.slice(0, body), footer(cols, ui)]
  while (out.length < rows) out.splice(out.length - 1, 0, fit([], cols))
  if (ui.overlay === 'legend') out = splice(out, legend(cols, rows, board.panes.length), cols, rows)
  if (ui.overlay === 'detail' && inspected)
    out = splice(out, detailBox(inspected, ui.focus, cols, rows), cols, rows)
  const item = inspected?.focus[ui.focus]
  if (ui.overlay === 'item' && item?.kind === 'item')
    out = splice(out, itemBox(item.item, ui.offset, cols, rows), cols, rows)
  return out.map((l) => fit(l, cols))
}
