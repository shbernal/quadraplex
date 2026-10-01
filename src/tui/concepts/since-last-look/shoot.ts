/**
 * Every screenshot in shots/, from headless frames. The vhs tapes in tapes/ are the
 * first choice; this exists because vhs captures no frames where its browser cannot draw.
 *   bun run src/tui/concepts/since-last-look/shoot.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dir
const shots: [string, number, number, string, ...string[]][] = [
  ['list-80x24', 80, 24, ''],
  ['story-80x24', 80, 24, 'jj\\r'],
  ['list-120x40', 120, 40, ''],
  ['story-120x40', 120, 40, '\\r'],
  ['scrubbed-120x40', 120, 40, '[[[['],
  ['month-120x40', 120, 40, '', '--since', '30d'],
]

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'sll-'))
mkdirSync(join(here, 'shots'), { recursive: true })
for (const [name, cols, rows, keys, ...flags] of shots) {
  const frame = Bun.spawnSync(
    ['bun', 'run', join(here, 'render.ts'), String(cols), String(rows), keys, ...flags],
    {
      env: { ...process.env, FORCE_COLOR: '3' },
    },
  )
  const ansi = join(scratch, `${name}.ansi`)
  writeFileSync(ansi, frame.stdout)
  Bun.spawnSync([
    'python3',
    join(here, 'png.py'),
    ansi,
    join(here, 'shots', `${name}.png`),
    String(cols),
    String(rows),
  ])
  console.log(`shots/${name}.png`)
}
