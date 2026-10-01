/**
 * Renders one tile-wall frame to stdout at a fixed size, so a layout change can be
 * inspected without a terminal. `bun run src/tui/concepts/tile-wall/render.ts 80 24 $'\t\r'`
 * Escape sequences pass through, so $'\e[C' is a right arrow.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { createElement } from 'react'
import { App } from './app.tsx'

const columns = Number(process.argv[2] ?? 100)
const rows = Number(process.argv[3] ?? 24)
/** Keys to replay before the frame is captured. An escape sequence is sent as one key. */
// oxlint-disable-next-line no-control-regex
const keys = (process.argv[4] ?? '').match(/\x1b\[[A-D]|\x1b\[Z|[\s\S]/g) ?? []
const frames: string[] = []

const stdout = Object.assign(new EventEmitter(), {
  columns,
  rows,
  write: (chunk: string) => frames.push(chunk),
}) as unknown as NodeJS.WriteStream

const input = new PassThrough()
const stdin = Object.assign(input, {
  isTTY: true,
  setRawMode: () => stdin,
  ref: () => stdin,
  unref: () => stdin,
}) as unknown as NodeJS.ReadStream

const instance = render(createElement(App), { stdout, stdin, patchConsole: false })

let delay = 60
for (const key of keys) {
  setTimeout(() => input.write(key), delay)
  delay += 40
}

setTimeout(() => {
  instance.unmount()
  process.stdout.write(`${frames.at(-1) ?? ''}\n`)
  process.exit(0)
}, delay + 300)
