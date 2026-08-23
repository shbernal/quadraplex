/**
 * NO_COLOR must still leave a changed row distinguishable, so every signal that has a
 * color also has a symbol and colors resolve to undefined rather than to another color.
 */
const colorless = Boolean(process.env.NO_COLOR)

const named = (color: string) => (colorless ? undefined : color)

/** The dashboard's palette, resolving to undefined under NO_COLOR. */
export const C = {
  github: named('magenta'),
  registries: named('red'),
  extensions: named('blue'),
  skills: named('#56b6c2'),
  up: named('green'),
  down: named('red'),
  warn: named('yellow'),
  muted: named('gray'),
  text: named('white'),
  accent: named('cyan'),
  unreleased: named('#d19a66'),
  star: named('yellow'),
  npm: named('red'),
  pypi: named('yellow'),
  ghcr: named('magenta'),
  dockerhub: named('#1d63ed'),
  chrome: named('green'),
  firefox: named('#ff7139'),
  clawhub: named('#e5484d'),
  pr: named('magenta'),
  issue: named('green'),
  cursor: named('#313244'),
  linked: named('#24273a'),
  ink: named('black'),
}
