import { C } from './theme.ts'

export { C }

/**
 * The control room draws its own borders, so every frame is a grid of styled segments
 * rather than nested Ink boxes. A title inset into a border, a scroll thumb riding the
 * right edge and an overlay spliced over the board all need column-exact control, which
 * flexbox does not give. Every glyph used here is one cell wide, emoji are avoided, and
 * an icon is always followed by a space, because a Nerd Font outline overflows its cell.
 */
export type Seg = {
  t: string
  c?: string | undefined
  bg?: string | undefined
  b?: boolean
  d?: boolean
  i?: boolean
}
export type Line = Seg[]

/** Nerd Font glyphs, all from the single-width private use area. */
const NERD = {
  github: '\u{F09B}',
  npm: '\u{E71E}',
  pypi: '\u{F0320}',
  ghcr: '\u{F4B7}',
  dockerhub: '\u{F308}',
  rubygems: '\u{E739}',
  jsr: '\u{E74E}',
  aur: '\u{F303}',
  packagist: '\u{E783}',
  nuget: '\u{E77F}',
  crates: '\u{E7A8}',
  chrome: '\u{F02AF}',
  firefox: '\u{F0239}',
  package: '\u{F03D7}',
  puzzle: '\u{F12E}',
  repo: '\u{F401}',
  star: '\u{F005}',
  fork: '\u{F402}',
  issue: '\u{F41B}',
  pr: '\u{F407}',
  commit: '\u{F417}',
  rocket: '\u{F427}',
  tag: '\u{F412}',
  download: '\u{F019}',
  calendar: '\u{F073}',
  users: '\u{F0C0}',
  clock: '\u{F017}',
  hourglass: '\u{F252}',
  sync: '\u{F021}',
  info: '\u{F05A}',
  archive: '\u{F187}',
  keyboard: '\u{F11C}',
  pulse: '\u{F21E}',
  link: '\u{F0C1}',
  skill: '\u{F15C}',
  clawhub: '\u{F03E9}',
  vscode: '\u{F0A1E}',
  openvsx: '\u{F0169}',
  /** Spinner frames, one cell each, read in turn. */
  spin: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
}

/**
 * The same signals without a patched font. Every glyph is one plain cell, and a store is
 * its initial, so the table reads on any terminal at the cost of looking like one.
 */
const ASCII: typeof NERD = {
  github: 'G',
  npm: 'n',
  pypi: 'p',
  ghcr: 'D',
  dockerhub: 'W',
  rubygems: 'g',
  jsr: 'J',
  aur: 'A',
  packagist: 'c',
  nuget: 'N',
  crates: 'R',
  chrome: 'C',
  firefox: 'F',
  package: 'P',
  puzzle: '#',
  repo: 'r',
  star: '*',
  fork: 'Y',
  issue: 'I',
  pr: 'P',
  commit: '@',
  rocket: 'R',
  tag: 'v',
  download: 'd',
  calendar: 'm',
  users: 'u',
  clock: 't',
  hourglass: '!',
  sync: '~',
  info: 'i',
  archive: 'A',
  keyboard: 'k',
  pulse: '+',
  link: '&',
  skill: 's',
  clawhub: 'H',
  vscode: 'V',
  openvsx: 'O',
  spin: '|/-\\',
}

export const G = { ...NERD }

/** Plain glyphs when asked for, and wherever icons are unlikely to have a font behind them. */
export function wantsAscii(env: Record<string, string | undefined> = process.env): boolean {
  return env.QUADRAPLEX_ASCII === '1' || env.TERM === 'dumb' || Boolean(env.NO_COLOR)
}

/** Swaps the table in place, so anything that reads `G` at draw time follows. */
export function selectGlyphs(ascii: boolean): void {
  Object.assign(G, ascii ? ASCII : NERD)
}

selectGlyphs(wantsAscii())

export const width = (line: Line) => line.reduce((n, s) => n + Array.from(s.t).length, 0)

export const seg = (t: string, c?: string, extra: Omit<Seg, 't' | 'c'> = {}): Seg => ({
  t,
  c,
  ...extra,
})

/** Columns [from, to) of a line, splitting segments at code point boundaries. */
function cut(line: Line, from: number, to: number): Line {
  const out: Line = []
  let at = 0
  for (const s of line) {
    const chars = Array.from(s.t)
    const start = Math.max(from - at, 0)
    const end = Math.min(to - at, chars.length)
    if (end > start) out.push({ ...s, t: chars.slice(start, end).join('') })
    at += chars.length
    if (at >= to) break
  }
  return out
}

/** Exactly `w` columns: truncated with an ellipsis, or padded with the given style. */
export function fit(line: Line, w: number, pad: Omit<Seg, 't'> = {}): Line {
  const n = width(line)
  if (n === w) return line
  if (n < w) return [...line, { ...pad, t: ' '.repeat(w - n) }]
  if (w <= 0) return []
  const kept = cut(line, 0, w - 1)
  const last = kept.at(-1) ?? pad
  return [...kept, { ...last, t: '…' }]
}

export function padLeft(line: Line, w: number): Line {
  const n = width(line)
  return n >= w ? fit(line, w) : [{ t: ' '.repeat(w - n) }, ...line]
}

export function overlay(base: Line, x: number, top: Line): Line {
  return [...cut(base, 0, x), ...top, ...cut(base, x + width(top), width(base))]
}

export function paint(line: Line, bg: string | undefined): Line {
  return bg ? line.map((s) => ({ ...s, bg: s.bg ?? bg })) : line
}

export const join = (parts: Line[], gap: Line = [{ t: ' ' }]): Line =>
  parts.flatMap((p, i) => (i === 0 ? p : [...gap, ...p]))

export const HEAVY = {
  tl: '┏',
  tr: '┓',
  bl: '┗',
  br: '┛',
  h: '━',
  v: '┃',
  l: '┫',
  r: '┣',
  thumb: '█',
}
export const ROUND = {
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  h: '─',
  v: '│',
  l: '┤',
  r: '├',
  thumb: '┃',
}
const DOUBLE = {
  tl: '╔',
  tr: '╗',
  bl: '╚',
  br: '╝',
  h: '═',
  v: '║',
  l: '╡',
  r: '╞',
  thumb: '█',
}
export type Border = typeof HEAVY

/** A border line with chips inset at the left and the right, rule filling the middle. */
export function rule(
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

/** A double-ruled overlay: title inset on top, chips inset at the bottom right. */
export function box(title: Line, body: Line[], w: number, footerChips: Line[]): Line[] {
  const b = DOUBLE
  const inner = w - 4
  return [
    rule(w, b, [b.tl, b.tr], [title], [], C.accent),
    ...body.map((l) => [seg(b.v + ' ', C.accent), ...fit(l, inner), seg(' ' + b.v, C.accent)]),
    rule(w, b, [b.bl, b.br], [], footerChips, C.accent),
  ]
}
