import { spawn } from 'node:child_process'
import { useApp, useInput, useStdout, type Key } from 'ink'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { Ecosystem, Target } from '../core/types.ts'
import { buildBoard, DEFAULT_VIEW, SORTS, viewBoard, type PaneId, type View } from './board.ts'
import { inspect, itemScrollMax, type Inspect } from './detail.ts'
import { frame, selectedRow, type Ui } from './frame.ts'
import { Lines } from './lines.tsx'
import type { Project } from './model.ts'
import { refresh, refreshTargets, type RefreshOutcome } from './spawn.ts'

function open(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
}

export function App({
  onRefresh = refresh,
  onRefreshTargets = refreshTargets,
  onAccounts,
  notice: initialNotice = null,
}: {
  onRefresh?: (only: Ecosystem | null) => Promise<RefreshOutcome>
  onRefreshTargets?: (targets: Target[]) => Promise<RefreshOutcome>
  /** Opens the accounts screen, when the dashboard is hosted by one. */
  onAccounts?: () => void
  /** What the refresh that led here went wrong on, shown until the next one. */
  notice?: string | null
}) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const cols = stdout.columns ?? 80
  const rows = stdout.rows ?? 24
  const [stamp, setStamp] = useState(0)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- stamp is the reload trigger
  const built = useMemo(() => buildBoard(), [stamp])
  const [view, setView] = useState<View>(DEFAULT_VIEW)
  /** The query from before the prompt opened, which escape restores. */
  const [typing, setTyping] = useState<string | null>(null)
  const board = useMemo(() => viewBoard(built, view), [built, view])
  const [focused, setFocused] = useState<PaneId | null>(null)
  const [cursors, setCursors] = useState<Partial<Record<PaneId, number>>>({})
  const [layer, setLayer] = useState<Ui['overlay']>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(initialNotice)
  const [inspected, setInspected] = useState<Inspect>()
  const [spot, setSpot] = useState(0)
  const [offset, setOffset] = useState(0)
  const scrolls = useRef<Partial<Record<PaneId, number>>>({})

  // Pane state is held by id and resolved against the board on every render, so a pane
  // that leaves after a refresh moves nobody else's cursor.
  const pane = Math.max(
    0,
    board.panes.findIndex((p) => p.id === focused),
  )
  const paneId = board.panes[pane]?.id
  // Clamped during render, so a filter or a refresh that shortens a pane never draws a
  // frame with its cursor past the end.
  const clamped = Object.fromEntries(
    board.panes.map((p) => [p.id, Math.max(0, Math.min(cursors[p.id] ?? 0, p.rows.length - 1))]),
  ) as Partial<Record<PaneId, number>>
  const ui: Ui = {
    pane,
    cursors: clamped,
    scrolls: scrolls.current,
    overlay: layer,
    busy,
    notice,
    focus: spot,
    offset,
    view,
    typing: typing !== null,
  }
  const current = selectedRow(board, ui)

  /** Hopping panes keeps the project: the cursor lands on its row there, if it has one. */
  const focus = useCallback(
    (next: number) => {
      const count = board.panes.length
      if (!count) return
      const target = board.panes[(next + count) % count]!
      const at = current ? target.rows.findIndex((r) => r.key === current.key) : -1
      if (at >= 0) setCursors((c) => ({ ...c, [target.id]: at }))
      setFocused(target.id)
    },
    [board, current],
  )

  const move = (by: number | 'top' | 'end') => {
    if (!paneId) return
    const count = board.panes[pane]!.rows.length
    const to = by === 'top' ? 0 : by === 'end' ? count - 1 : (clamped[paneId] ?? 0) + by
    setCursors((c) => ({ ...c, [paneId]: Math.max(0, Math.min(count - 1, to)) }))
  }

  const runRefresh = async (all: boolean) => {
    const sources = all || !board.panes[pane] ? [null] : board.panes[pane].sources
    const problems: string[] = []
    setNotice(null)
    for (const only of sources) {
      setBusy(`refreshing ${only ?? 'everything'}`)
      const outcome = await onRefresh(only)
      if (outcome) problems.push(sources.length > 1 && only ? `${only}: ${outcome}` : outcome)
    }
    setBusy(null)
    setNotice(problems.length ? `refresh: ${problems.join('; ')}` : null)
    setStamp((s) => s + 1)
  }

  /** The open detail is rebuilt from the store afterwards, so it shows what was fetched. */
  const refreshProject = async (project: Project) => {
    setNotice(null)
    setBusy(`refreshing ${project.name}`)
    const outcome = await onRefreshTargets(project.targets)
    setBusy(null)
    setNotice(outcome && `refresh: ${outcome}`)
    const next = buildBoard()
      .panes.flatMap((p) => p.rows)
      .find((r) => r.project.key === project.key)?.project
    if (next) setInspected(inspect(next))
    else setLayer(null)
    setStamp((s) => s + 1)
  }

  /** The open issue or PR body, while one is being read. */
  const reading = layer === 'item' ? inspected?.focus[spot] : undefined

  const overlayInput = (input: string, key: Key) => {
    const back = key.escape || input === 'q'
    if (layer === 'legend') {
      if (back || input === '?' || key.return) setLayer(null)
    } else if (layer === 'item' && reading?.kind === 'item') {
      const max = itemScrollMax(reading.item, cols, rows)
      const scroll = (by: number) => setOffset((o) => Math.max(0, Math.min(max, o + by)))
      if (back) setLayer('detail')
      else if (input === 'j' || key.downArrow) scroll(1)
      else if (input === 'k' || key.upArrow) scroll(-1)
      else if (key.pageDown || input === ' ') scroll(10)
      else if (key.pageUp) scroll(-10)
      else if (input === 'o') open(reading.url)
    } else if (inspected) {
      const last = inspected.focus.length - 1
      const to = (n: number) => setSpot(Math.max(0, Math.min(last, n)))
      const spotted = inspected.focus[spot]
      if (back) setLayer(null)
      else if (input === 'j' || key.downArrow) to(spot + 1)
      else if (input === 'k' || key.upArrow) to(spot - 1)
      else if (input === 'g') to(0)
      else if (input === 'G') to(last)
      else if (key.return && spotted?.kind === 'item') {
        setOffset(0)
        setLayer('item')
      } else if (input === 'o' && spotted) open(spotted.url)
      else if (input === 'r' && !busy) void refreshProject(inspected.project)
    }
  }

  const query = (next: string) => {
    setView((v) => ({ ...v, query: next }))
    setCursors({})
  }

  /** A filter is a text field while it is open, so nothing else can steal a letter. */
  const typingInput = (input: string, key: Key) => {
    if (key.escape) {
      query(typing ?? '')
      setTyping(null)
    } else if (key.return) setTyping(null)
    else if (key.backspace || key.delete) query(view.query.slice(0, -1))
    else if (input && !key.ctrl && !key.meta && !key.tab) query(view.query + input)
  }

  useInput((input, key) => {
    if (typing !== null) return typingInput(input, key)
    if (layer) return overlayInput(input, key)
    if (input === 'q') exit()
    else if (input === '/') setTyping(view.query)
    else if (input === 's' && paneId)
      setView((v) => {
        const at = SORTS.indexOf(v.sorts[paneId] ?? 'default')
        return { ...v, sorts: { ...v.sorts, [paneId]: SORTS[(at + 1) % SORTS.length]! } }
      })
    else if (input === 'c') {
      setView(DEFAULT_VIEW)
      setCursors({})
    } else if (key.tab && key.shift) focus(pane - 1)
    else if (key.tab || input === 'l' || key.rightArrow) focus(pane + 1)
    else if (input === 'h' || key.leftArrow) focus(pane - 1)
    else if (/^[1-9]$/.test(input) && Number(input) <= board.panes.length) focus(Number(input) - 1)
    else if (input === 'j' || key.downArrow) move(1)
    else if (input === 'k' || key.upArrow) move(-1)
    else if (input === 'g') move('top')
    else if (input === 'G') move('end')
    else if (key.pageDown) move(10)
    else if (key.pageUp) move(-10)
    else if (key.return && current) {
      setInspected(inspect(current.project))
      setSpot(0)
      setLayer('detail')
    } else if (input === '?') setLayer('legend')
    else if (input === 'o' && current) open(current.url)
    else if ((input === 'r' || input === 'R') && !busy) void runRefresh(input === 'R')
    else if (input === 'a' && !busy && onAccounts) onAccounts()
  })

  return <Lines lines={frame(board, ui, cols, rows, inspected)} cols={cols} rows={rows} />
}
