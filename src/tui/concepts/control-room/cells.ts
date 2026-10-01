import { colorless } from '../../theme.ts'

/**
 * The control room draws its own borders, so every frame is a grid of styled segments
 * rather than nested Ink boxes. A title inset into a border, a scroll thumb riding the
 * right edge and an overlay spliced over the board all need column-exact control, which
 * flexbox does not give. Every glyph used here is one cell wide, emoji are avoided, and
 * a Nerd Font icon is always followed by a space, because its outline overflows its cell.
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

const named = (color: string) => (colorless ? undefined : color)

export const C = {
  github: named('magenta'),
  registries: named('red'),
  extensions: named('blue'),
  up: named('green'),
  down: named('red'),
  warn: named('yellow'),
  muted: named('gray'),
  text: named('white'),
  accent: named('cyan'),
  star: named('yellow'),
  npm: named('red'),
  pypi: named('yellow'),
  chrome: named('green'),
  firefox: named('#ff7139'),
  pr: named('magenta'),
  issue: named('green'),
  cursor: named('#313244'),
  linked: named('#24273a'),
  ink: named('black'),
}

/** Nerd Font glyphs, all from the single-width private use area. */
export const G = {
  github: '\u{F09B}',
  npm: '\u{F487}',
  pypi: '\u{F0320}',
  chrome: '\u{F02AF}',
  firefox: '\u{F0239}',
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
  radar: '\u{F012}',
  link: '\u{F0C1}',
}

export const width = (line: Line) => line.reduce((n, s) => n + Array.from(s.t).length, 0)

export const seg = (t: string, c?: string, extra: Omit<Seg, 't' | 'c'> = {}): Seg => ({
  t,
  c,
  ...extra,
})

/** Columns [from, to) of a line, splitting segments at code point boundaries. */
export function cut(line: Line, from: number, to: number): Line {
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
