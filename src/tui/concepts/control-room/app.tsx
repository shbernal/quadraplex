import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { Ecosystem } from '../../../core/types.ts'
import { buildBoard } from './board.ts'
import { frame, selectedRow, type Ui } from './frame.ts'

const BIN = fileURLToPath(new URL('../../../bin.ts', import.meta.url))

/** The TUI never fetches: `r` runs the CLI's own refresh, one store at a time. */
function refresh(only: Ecosystem | null): Promise<void> {
  return new Promise((resolve) => {
    const args = only ? ['refresh', '--only', only] : ['refresh']
    const child = spawn(process.execPath, [BIN, ...args], { stdio: 'ignore' })
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
}

function open(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
}

export function App() {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const cols = stdout.columns ?? 80
  const rows = stdout.rows ?? 24
  const [stamp, setStamp] = useState(0)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- stamp is the reload trigger
  const board = useMemo(() => buildBoard(), [stamp])
  const [pane, setPane] = useState(0)
  const [cursors, setCursors] = useState([0, 0, 0])
  const [layer, setLayer] = useState<Ui['overlay']>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const scrolls = useRef([0, 0, 0])

  const ui: Ui = { pane, cursors, scrolls: scrolls.current, overlay: layer, busy }
  const current = selectedRow(board, ui)

  /** Hopping panes keeps the project: the cursor lands on its row there, if it has one. */
  const focus = useCallback(
    (next: number) => {
      const target = (next + board.panes.length) % board.panes.length
      const at = current ? board.panes[target]!.rows.findIndex((r) => r.key === current.key) : -1
      if (at >= 0) setCursors((c) => c.map((v, i) => (i === target ? at : v)))
      setPane(target)
    },
    [board, current],
  )

  const move = (by: number | 'top' | 'end') => {
    const count = board.panes[pane]!.rows.length
    setCursors((c) =>
      c.map((v, i) => {
        if (i !== pane) return v
        const to = by === 'top' ? 0 : by === 'end' ? count - 1 : v + by
        return Math.max(0, Math.min(count - 1, to))
      }),
    )
  }

  const runRefresh = async (all: boolean) => {
    const sources = all ? [null] : board.panes[pane]!.sources
    for (const only of sources) {
      setBusy(`refreshing ${only ?? 'everything'}`)
      await refresh(only)
    }
    setBusy(null)
    setStamp((s) => s + 1)
  }

  useInput((input, key) => {
    if (layer) {
      if (key.escape || input === 'q' || input === '?' || key.return) setLayer(null)
      if (input === 'o' && current) open(current.url)
      return
    }
    if (input === 'q') exit()
    else if (key.tab && key.shift) focus(pane - 1)
    else if (key.tab || input === 'l' || key.rightArrow) focus(pane + 1)
    else if (input === 'h' || key.leftArrow) focus(pane - 1)
    else if (input === '1' || input === '2' || input === '3') focus(Number(input) - 1)
    else if (input === 'j' || key.downArrow) move(1)
    else if (input === 'k' || key.upArrow) move(-1)
    else if (input === 'g') move('top')
    else if (input === 'G') move('end')
    else if (key.pageDown) move(10)
    else if (key.pageUp) move(-10)
    else if (key.return && current) setLayer('detail')
    else if (input === '?') setLayer('legend')
    else if (input === 'o' && current) open(current.url)
    else if ((input === 'r' || input === 'R') && !busy) void runRefresh(input === 'R')
  })

  const lines = frame(board, ui, cols, rows)
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line.map((s, j) => (
            <Text key={j} color={s.c} backgroundColor={s.bg} bold={s.b} dimColor={s.d} italic={s.i}>
              {s.t}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}
