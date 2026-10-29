/**
 * Renders one dashboard frame to stdout at a fixed size, so a layout change can be
 * inspected without a terminal. `bun run scripts/render-dashboard.ts 100 24 [keys]`
 * `--accounts` opens the accounts screen instead, with canned probes and refreshes so the
 * frame does not depend on the network.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { createElement } from 'react'
import type { Suggestion } from '../src/commands/init.ts'
import { Root } from '../src/tui/onboard.tsx'

const accounts = process.argv.includes('--accounts')
const args = process.argv.slice(2).filter((a) => a !== '--accounts')
const columns = Number(args[0] ?? 100)
const rows = Number(args[1] ?? 24)
/** Keys to replay before the frame is captured, for example "jjj\r" to open a detail. */
const keys = args[2] ?? ''

const canned: Suggestion[] = [
  { ecosystem: 'npm', value: 'you', source: 'gh', status: 'found', count: 14 },
  { ecosystem: 'pypi', value: 'you', source: 'gh', status: 'unchecked', reason: 'request failed' },
  { ecosystem: 'github', value: 'you', source: 'gh', status: 'found', count: 31 },
  { ecosystem: 'ghcr', value: 'you', source: 'gh', status: 'found', count: 2 },
  { ecosystem: 'dockerhub', value: 'you', source: 'gh', status: 'found', count: 1 },
  { ecosystem: 'rubygems', value: 'you', source: 'gh', status: 'found', count: 2 },
  {
    ecosystem: 'amo',
    value: '20068285',
    source: 'gh',
    status: 'found',
    count: 4,
    label: 'you, by display name',
  },
  { ecosystem: 'cws', value: 'you', source: 'gh', status: 'found', count: 1 },
  { ecosystem: 'clawhub', value: 'you', source: 'gh', status: 'found', count: 3 },
]
const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 30))
const props = {
  start: accounts ? ('accounts' as const) : ('dashboard' as const),
  onProbe: (flags: Record<string, string>) =>
    later(canned.filter((s) => !flags.only || s.ecosystem === flags.only)),
  onRefresh: () => later(null),
  onRefreshTargets: () => later(null),
}
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

const instance = render(createElement(Root, props), { stdout, stdin, patchConsole: false })

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
