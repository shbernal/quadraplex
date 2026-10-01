/**
 * "Since last look", a change-first dashboard concept. Reads the store, never fetches.
 *
 *   bun run src/tui/concepts/since-last-look/index.ts [--since 7d|2026-09-20]
 *
 * Quitting with q records the newest refresh shown as the next run's anchor, under XDG
 * state. SINCE_LAST_LOOK_READONLY=1 skips that write.
 */
import { createElement } from 'react'
import { parseDuration } from '../../../core/duration.ts'
import type { AnchorSource } from './app.tsx'
import { epochIndexAt, loadTimeline, type Timeline } from './look.ts'
import { lastLookBefore } from './marker.ts'

export function resolveAnchor(
  timeline: Timeline,
  since: string | undefined,
): { index: number; source: AnchorSource } {
  const latest = Date.parse(timeline.epochs.at(-1)!.at)
  if (since) {
    const at = /^\d{4}-\d{2}-\d{2}/.test(since) ? Date.parse(since) : latest - parseDuration(since)
    return { index: epochIndexAt(timeline.epochs, at), source: 'flag' }
  }
  const look = lastLookBefore(timeline.epochs.at(-1)!.at)
  if (look) return { index: epochIndexAt(timeline.epochs, Date.parse(look)), source: 'look' }
  return { index: epochIndexAt(timeline.epochs, latest - 3 * 86_400_000), source: 'default' }
}

export function sinceArg(argv: string[]): string | undefined {
  const at = argv.indexOf('--since')
  return at >= 0 ? argv[at + 1] : undefined
}

if (import.meta.main) {
  const timeline = loadTimeline()
  if (timeline.epochs.length === 0) {
    console.error('The store is empty. Run `qplex refresh` first.')
    process.exit(1)
  }
  const { index, source } = resolveAnchor(timeline, sinceArg(process.argv))
  const [{ render }, { App }] = await Promise.all([import('ink'), import('./app.tsx')])
  const instance = render(createElement(App, { timeline, initial: index, source }), {
    exitOnCtrlC: false,
  })
  await instance.waitUntilExit()
}
