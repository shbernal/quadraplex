/**
 * Renders a frame headlessly and photographs it, for when a terminal recorder is not to
 * hand: the ANSI frame becomes an HTML page and headless Chromium screenshots it.
 * `bun run src/tui/concepts/facility/snapshot.ts <cols> <rows> <out.png> [keys]`
 * NO_COLOR is passed through, so the colourless reading can be photographed too.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [cols = '80', rows = '24', out = 'frame.png', keys = ''] = process.argv.slice(2)
const here = new URL('.', import.meta.url).pathname
const env = { ...process.env, ...(process.env.NO_COLOR ? {} : { FORCE_COLOR: '3' }) }
const frame = spawnSync('bun', ['run', `${here}render.ts`, cols, rows, keys], {
  env,
  encoding: 'utf8',
}).stdout

const PALETTE: Record<number, string> = {
  30: '#1e2030',
  31: '#ed8796',
  32: '#a6da95',
  33: '#eed49f',
  34: '#8aadf4',
  35: '#c6a0f6',
  36: '#8bd5ca',
  37: '#cad3f5',
  90: '#6e738d',
  97: '#ffffff',
}
const FG = '#cad3f5'
const BG = '#181926'

type Style = { fg?: string; bold?: boolean; dim?: boolean; inverse?: boolean }
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function span(text: string, s: Style): string {
  if (!text) return ''
  let fg = s.fg ?? FG
  let bg = 'transparent'
  if (s.inverse) [fg, bg] = [BG, s.fg ?? FG]
  const css = [
    `color:${fg}`,
    `background:${bg}`,
    s.bold ? 'font-weight:700' : '',
    s.dim ? 'opacity:.55' : '',
  ]
  return `<span style="${css.filter(Boolean).join(';')}">${esc(text)}</span>`
}

const lines = frame.replace(/\n$/, '').split('\n')
const body = lines
  .map((line) => {
    let style: Style = {}
    let html = ''
    // oxlint-disable-next-line no-control-regex -- an ANSI escape is the input
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      // oxlint-disable-next-line no-control-regex
      const m = /^\x1b\[([0-9;]*)m$/.exec(part)
      if (!m) {
        html += span(part, style)
        continue
      }
      const codes = (m[1] || '0').split(';').map(Number)
      for (const code of codes) {
        if (code === 0) style = {}
        else if (code === 1) style = { ...style, bold: true }
        else if (code === 2) style = { ...style, dim: true }
        else if (code === 22) style = { ...style, bold: false, dim: false }
        else if (code === 7) style = { ...style, inverse: true }
        else if (code === 27) style = { ...style, inverse: false }
        else if (code === 39) style = { ...style, fg: undefined }
        else if (PALETTE[code]) style = { ...style, fg: PALETTE[code] }
      }
    }
    return `<div class="l">${html || '&nbsp;'}</div>`
  })
  .join('')

const cellW = 9.25
const cellH = 19
const pad = 14
const width = Math.ceil(Number(cols) * cellW + pad * 2)
const height = Number(rows) * cellH + pad * 2
const page = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:${BG}}
body{padding:${pad}px;font:15px/${cellH}px "CaskaydiaMono Nerd Font","JetBrains Mono",monospace;color:${FG}}
.l{white-space:pre;height:${cellH}px}
</style>${body}`
const htmlPath = resolve(out.replace(/\.png$/, '.html'))
writeFileSync(htmlPath, page)
const shot = spawnSync(
  'chromium',
  [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--screenshot=${resolve(out)}`,
    `file://${htmlPath}`,
  ],
  { encoding: 'utf8' },
)
spawnSync('rm', ['-f', htmlPath])
if (shot.status !== 0) {
  process.stderr.write(shot.stderr)
  process.exit(1)
}
process.stdout.write(`${resolve(out)}\n`)
