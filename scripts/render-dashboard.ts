/**
 * Renders one dashboard frame to stdout at a fixed width, so a layout change can be
 * inspected without a terminal. `bun run scripts/render-dashboard.ts 80`
 */
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { createElement } from 'react'
import { App } from '../src/tui/app.tsx'

const columns = Number(process.argv[2] ?? 100)
const rows = Number(process.argv[3] ?? 24)
const frames: string[] = []

const stdout = Object.assign(new EventEmitter(), {
  columns,
  rows,
  write: (chunk: string) => frames.push(chunk),
}) as unknown as NodeJS.WriteStream

const stdin = Object.assign(new EventEmitter(), {
  isTTY: true,
  setRawMode: () => {},
  ref: () => {},
  unref: () => {},
  read: () => null,
  setEncoding: () => {},
  resume: () => {},
  pause: () => {},
}) as unknown as NodeJS.ReadStream

const instance = render(createElement(App), { stdout, stdin, patchConsole: false })
setTimeout(() => {
  instance.unmount()
  process.stdout.write(`${frames.at(-1) ?? ''}\n`)
  process.exit(0)
}, 300)
