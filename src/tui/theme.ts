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
