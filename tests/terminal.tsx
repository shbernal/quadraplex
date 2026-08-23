import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import type { ReactElement } from 'react'

/** Mounts an Ink element on a fake terminal, the way scripts/render-dashboard.ts does. */
export function mountTerminal(element: ReactElement, columns: number, rows: number) {
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
  const instance = render(element, {
    stdout,
    stdin,
    patchConsole: false,
    // Every frame is written whole, rather than diffed against the one before.
    debug: true,
  })
  let exited = false
  void instance.waitUntilExit().then(() => (exited = true))
  return {
    frame: () => frames.at(-1) ?? '',
    exited: () => exited,
    press: async (keys: string) => {
      for (const key of keys) {
        input.write(key)
        await Bun.sleep(20)
      }
      await Bun.sleep(40)
    },
    unmount: () => instance.unmount(),
  }
}
