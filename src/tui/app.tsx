import { spawn } from 'node:child_process'
import { useCallback, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { compactNumber, formatDelta, relativeAge, since } from '../core/format.ts'
import {
  awaitingCurves,
  buildProjects,
  focusables,
  homeUrl,
  projectItems,
  projectStargazers,
  type Project,
} from './model.ts'
import { Sparkline } from './sparkline.tsx'
import { Detail, Item } from './detail.tsx'
import { MARKERS, theme } from './theme.ts'

/** Columns drop by priority as the terminal narrows. Deltas are the last thing to go. */
function layout(width: number) {
  return {
    age: width >= 96,
    spark: width >= 78 ? Math.min(16, Math.floor(width / 6)) : 0,
    stars: width >= 62,
    delta: true,
    name: Math.max(12, Math.min(28, Math.floor(width * 0.28))),
  }
}

function open(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
}

function Row({ project, selected, width }: { project: Project; selected: boolean; width: number }) {
  const cols = layout(width)
  const marker = project.changed ? MARKERS.changed : project.stale ? MARKERS.stale : MARKERS.quiet
  const downloads = project.downloads
  const stars = project.stars
  const newest = project.targets.reduce(
    (latest, target) => (target.fetchedAt > latest ? target.fetchedAt : latest),
    project.targets[0]!.fetchedAt,
  )

  return (
    <Box width={width}>
      <Text color={selected ? theme.accent : undefined} inverse={selected}>
        {' '}
        {marker}{' '}
      </Text>
      <Text bold={selected}>{project.name.slice(0, cols.name).padEnd(cols.name)}</Text>
      <Text>{(downloads ? compactNumber(downloads.value) : '-').padStart(7)}</Text>
      {cols.delta ? (
        <Text color={downloads?.delta ? theme.up : theme.muted}>
          {' '}
          {(downloads ? formatDelta(downloads.delta) : '').padStart(7)}
        </Text>
      ) : null}
      {cols.stars ? (
        <Text>
          {'   '}
          {(stars ? `${stars.value}` : '-').padStart(6)}
          <Text color={stars?.delta ? theme.up : theme.muted}>
            {' '}
            {(stars ? formatDelta(stars.delta) : '').padStart(5)}
          </Text>
        </Text>
      ) : null}
      {cols.spark ? (
        <Box marginLeft={2}>
          <Sparkline
            values={project.series.map((point) => point.downloads)}
            width={cols.spark}
            color={theme.accent}
          />
        </Box>
      ) : null}
      {cols.age ? <Text color={theme.muted}>{`  ${relativeAge(newest)}`.padStart(10)}</Text> : null}
    </Box>
  )
}

function Header({ projects, width }: { projects: Project[]; width: number }) {
  const cols = layout(width)
  const changed = projects.filter((p) => p.changed).length
  const targets = projects.reduce((total, p) => total + p.targets.length, 0)
  const newest = projects
    .flatMap((p) => p.targets.map((t) => t.fetchedAt))
    .reduce((latest, at) => (at > latest ? at : latest), '')

  return (
    <Box flexDirection="column" width={width}>
      <Box width={width}>
        <Box flexShrink={0}>
          <Text color={theme.heading} bold>
            {' QUADRAPLEX '}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color={theme.muted} wrap="truncate-end">
            {targets} targets in {projects.length} projects, {changed} changed
            {newest ? `, refreshed ${relativeAge(newest)}` : ''}
          </Text>
        </Box>
      </Box>
      <Box width={width}>
        <Text color={theme.muted} wrap="truncate-end">
          {'   '}
          {'PROJECT'.padEnd(cols.name)}
          {'WEEK'.padStart(7)}
          {cols.delta ? ` ${'DELTA'.padStart(7)}` : ''}
          {cols.stars ? `   ${'STARS'.padStart(6)} ${'+/-'.padStart(5)}` : ''}
        </Text>
      </Box>
    </Box>
  )
}

export function App({ onRefresh }: { onRefresh?: () => Promise<void> }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = Math.max(stdout?.columns ?? 80, 40)
  const rows = Math.max((stdout?.rows ?? 24) - 7, 3)

  const [projects, setProjects] = useState<Project[]>(() => buildProjects())
  const [cursor, setCursor] = useState(0)
  const [view, setView] = useState<'list' | 'detail' | 'item'>('list')
  const [detailCursor, setDetailCursor] = useState(0)
  const [scroll, setScroll] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)

  // Clamped during render rather than corrected in an effect, so a refresh that shortens
  // the list never draws a frame with the cursor past the end.
  const index = Math.max(0, Math.min(cursor, projects.length - 1))
  const selected = projects[index]
  const items = useMemo(() => (selected ? projectItems(selected) : []), [selected])
  // Both read the store, so they are recomputed with the selection rather than on every
  // keystroke, exactly like the open items above.
  const stargazers = useMemo(() => (selected ? projectStargazers(selected) : null), [selected])
  const waiting = useMemo(() => (selected ? awaitingCurves(selected) : false), [selected])
  // Targets and open items share one cursor, so "o" always has an unambiguous answer and
  // the pane has a single thing to scroll into view.
  const focus = useMemo(() => (selected ? focusables(selected, items) : []), [selected, items])
  const focusIndex = Math.min(detailCursor, Math.max(focus.length - 1, 0))
  const current = focus[focusIndex]
  const item = current?.kind === 'item' ? current.item : undefined

  const reload = useCallback(() => {
    setProjects(buildProjects())
  }, [])

  /**
   * The dashboard never fetches. It shells out to the same CLI so the "breadth comes
   * from cache" rule holds for humans exactly as it does for agents.
   */
  const runRefresh = useCallback(async () => {
    setBusy('refreshing')
    await (onRefresh
      ? onRefresh()
      : new Promise<void>((resolve) => {
          const child = spawn(process.execPath, [process.argv[1]!, 'refresh'], { stdio: 'ignore' })
          child.on('exit', () => resolve())
          child.on('error', () => resolve())
        }))
    setBusy(null)
    reload()
  }, [onRefresh, reload])

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (view === 'item') return setView('detail')
      if (view === 'detail') return setView('list')
      return exit()
    }
    if (busy) return

    const down = input === 'j' || key.downArrow
    const up = input === 'k' || key.upArrow

    if (view === 'item') {
      if (down) setScroll((s) => s + 1)
      if (up) setScroll((s) => Math.max(s - 1, 0))
      if (input === 'o' && item) open(item.url)
      return
    }

    if (view === 'detail') {
      if (down) setDetailCursor((c) => Math.min(c + 1, Math.max(focus.length - 1, 0)))
      if (up) setDetailCursor((c) => Math.max(c - 1, 0))
      if (key.return && item) {
        setScroll(0)
        setView('item')
      }
      if (input === 'o' && current) open(current.url)
      return
    }

    if (down) setCursor(Math.min(index + 1, projects.length - 1))
    if (up) setCursor(Math.max(index - 1, 0))
    if (input === 'g') setCursor(0)
    if (input === 'G') setCursor(projects.length - 1)
    if (key.return) {
      setDetailCursor(0)
      setView('detail')
    }
    if (input === 'o' && selected) open(homeUrl(selected))
    if (input === 'r') void runRefresh()
  })

  const window = useMemo(() => {
    const start = Math.max(0, Math.min(index - Math.floor(rows / 2), projects.length - rows))
    return projects.slice(start, start + rows)
  }, [projects, index, rows])

  if (projects.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.heading}>QUADRAPLEX</Text>
        <Text>The store is empty. Press r to refresh, or run "qplex refresh".</Text>
        <Text color={theme.muted}>{busy ?? 'q quit'}</Text>
      </Box>
    )
  }

  if (view === 'item' && item) return <Item item={item} offset={scroll} width={width} rows={rows} />
  if (view === 'detail' && selected) {
    return (
      <Detail
        project={selected}
        items={items}
        cursor={focusIndex}
        stargazers={stargazers}
        waiting={waiting}
        width={width}
        rows={rows}
      />
    )
  }

  return (
    <Box flexDirection="column">
      <Header projects={projects} width={width} />
      {window.map((project) => (
        <Row
          key={project.key}
          project={project}
          selected={project.key === selected?.key}
          width={width}
        />
      ))}
      <Box marginTop={1} width={width}>
        <Text color={theme.muted} wrap="truncate-end">
          {busy
            ? `${busy}...`
            : `${MARKERS.changed} changed   ${MARKERS.stale} stale   "new" means no baseline yet`}
        </Text>
      </Box>
      <Box width={width}>
        <Text color={theme.muted} wrap="truncate-end">
          {' j/k move   enter detail   o open   r refresh   q quit'}
          {selected?.downloads?.baselineAt
            ? `   deltas${since(selected.downloads.baselineAt)}`
            : ''}
        </Text>
      </Box>
    </Box>
  )
}
