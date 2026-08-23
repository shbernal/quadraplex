/**
 * Renders one dashboard frame to stdout at a fixed width, so a layout change can be
 * inspected without a terminal. `bun run scripts/render-dashboard.ts 80`
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { createElement } from 'react'
import { App } from '../src/tui/app.tsx'

const columns = Number(process.argv[2] ?? 100)
const rows = Number(process.argv[3] ?? 24)
/** Keys to replay before the frame is captured, for example "jjj\r" to open a detail. */
const keys = process.argv[4] ?? ''
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
