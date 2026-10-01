/**
 * One frame of the concept at a fixed size, without a terminal. Never records a look.
 *   bun run src/tui/concepts/since-last-look/render.ts <cols> <rows> [keys] [--since 7d]
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { createElement } from 'react'
import { App } from './app.tsx'
import { loadTimeline } from './look.ts'
import { resolveAnchor, sinceArg } from './index.ts'

process.env.SINCE_LAST_LOOK_READONLY = '1'
const columns = Number(process.argv[2] ?? 80)
const rows = Number(process.argv[3] ?? 24)
const keys = (process.argv[4] ?? '').replace(/\\r/g, '\r').replace(/\\e/g, '\x1b')
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

const timeline = loadTimeline()
const { index, source } = resolveAnchor(timeline, sinceArg(process.argv))
const instance = render(createElement(App, { timeline, initial: index, source }), {
  stdout,
  stdin,
  patchConsole: false,
})

let delay = 80
for (const key of keys) {
  setTimeout(() => input.write(key), delay)
  delay += 60
}

setTimeout(() => {
  instance.unmount()
  process.stdout.write(`${frames.at(-1) ?? ''}\n`)
  process.exit(0)
}, delay + 300)
