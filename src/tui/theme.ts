/**
 * NO_COLOR must still leave a changed row distinguishable, so every signal that has a
 * color also has a symbol and colors resolve to undefined rather than to another color.
 */
export const colorless = Boolean(process.env.NO_COLOR)

export const theme = {
  accent: colorless ? undefined : 'green',
  heading: colorless ? undefined : 'cyan',
  up: colorless ? undefined : 'green',
  down: colorless ? undefined : 'red',
  muted: colorless ? undefined : 'gray',
  warn: colorless ? undefined : 'yellow',
}

export const MARKERS = { changed: '*', stale: '!', quiet: ' ' }

/** A second glyph in the same cell, because a row can have moved and drifted at once. */
export const DRIFT = { versions: 'v', unreleased: '^', none: ' ' }

/**
 * A fixed slot per ecosystem, so a project's stores read off one column at a glance and
 * the header doubles as the legend: "npGAC" spells the slots out in order.
 */
export const SOURCE_SLOTS = [
  { ecosystem: 'npm', letter: 'n' },
  { ecosystem: 'pypi', letter: 'p' },
  { ecosystem: 'github', letter: 'G' },
  { ecosystem: 'amo', letter: 'A' },
  { ecosystem: 'cws', letter: 'C' },
] as const

export const SOURCE_HEADER = SOURCE_SLOTS.map((slot) => slot.letter).join('')

/**
 * A delta reads by sign before it reads by value, so green is up and red is down. Every
 * delta is printed with its own sign, which is what keeps NO_COLOR readable, and an
 * unknown one stays grey: "new" is not a fall.
 */
export function deltaColor(delta: number | null | undefined): string | undefined {
  if (delta === null || delta === undefined || delta === 0) return theme.muted
  return delta > 0 ? theme.up : theme.down
}
