/**
 * The last look is a viewer's bookmark, not data about the portfolio, so it lives under
 * XDG state rather than in the store: deleting it loses a convenience and costs nothing.
 * What is recorded is the newest refresh the viewer was shown, never the wall clock, so
 * "since last look" means "since the data I last saw", however long ago that viewing was.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function file(): string {
  const xdg = process.env.XDG_STATE_HOME
  const root = xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.local', 'state')
  return join(root, 'quadraplex', 'since-last-look.json')
}

/** Every refresh a viewer has quit on, oldest first. */
export function readLooks(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as { looks?: string[] }
    return parsed.looks ?? []
  } catch {
    return []
  }
}

export function recordLook(epochAt: string): void {
  if (process.env.SINCE_LAST_LOOK_READONLY) return
  const looks = readLooks().filter((at) => at !== epochAt)
  looks.push(epochAt)
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), `${JSON.stringify({ looks: looks.slice(-50) }, null, 2)}\n`)
}

/**
 * The newest look older than the newest refresh. When nothing has been refreshed since the
 * last look, the one before it still answers the question, instead of an empty screen.
 */
export function lastLookBefore(latestAt: string): string | null {
  return (
    readLooks()
      .filter((at) => at < latestAt)
      .at(-1) ?? null
  )
}
