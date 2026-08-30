import { spawn } from 'node:child_process'
import { useCallback, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { compactNumber, formatDelta, relativeAge, since } from '../core/format.ts'
import {
  applyView,
  awaitingCurves,
  buildProjects,
  DEFAULT_VIEW,
  focusables,
  homeUrl,
  projectItems,
  projectStargazers,
  SCOPES,
  SORTS,
  type Kind,
  type Project,
  type Reach,
  type Rating,
  type View,
} from './model.ts'
import { Sparkline } from './sparkline.tsx'
import { Detail, Item } from './detail.tsx'
import { Help } from './help.tsx'
import { deltaColor, DRIFT, MARKERS, SOURCE_HEADER, SOURCE_SLOTS, theme } from './theme.ts'

/** The headline number, the delta trailing it and the rating: widths both tables share. */
const VALUE = 7
const DELTA = 8
const STARS = 6
const STARS_DELTA = 6
const RATING = 12

/**
 * A number and the movement behind it in one column. The number keeps the aligned edge so
 * the figures still read as a column, and the delta trails it in its own colour, printed
 * only when there is movement to print.
 */
function Metric({
  text,
  delta,
  width,
  trail,
}: {
  text: string
  delta?: number | null
  width: number
  trail: number
}) {
  const moved = delta === undefined || delta === 0 ? '' : formatDelta(delta)
  return (
    <Text>
      {text.padStart(width)}
      <Text color={deltaColor(delta)}>{(moved ? ` ${moved}` : '').padEnd(trail)}</Text>
    </Text>
  )
}

const any = (projects: Project[], has: (project: Project) => unknown) =>
  projects.some((project) => Boolean(has(project)))

/**
 * Two tables, one grid. A package reports downloads and a trace, an extension reports
 * users and a rating, so each gets its own block of metric columns, and the block is one
 * width for both so the GitHub columns they share stay on the same characters down the
 * whole screen. Columns are allocated in priority order against the width the terminal
 * actually has, so a narrow one drops whole columns rather than shaving every one of them
 * into noise, and a column nothing on screen can fill is never allocated at all.
 */
function layout(width: number, projects: Project[]) {
  const packages = projects.filter((p) => p.kind === 'package')
  const extensions = projects.filter((p) => p.kind === 'extension')
  const name = Math.max(12, Math.min(28, Math.floor(width * 0.28)))
  const sparkWidth = Math.min(16, Math.floor(width / 6))
  let left = width - 4 - name
  const take = (cost: number, wanted = true) => {
    if (!wanted || left < cost) return false
    left -= cost
    return true
  }

  const src = take(SOURCE_SLOTS.length + 1)
  const value = take(VALUE + DELTA)
  const stars = take(
    3 + STARS + STARS_DELTA,
    any(projects, (p) => p.stars),
  )
  // The trace and the rating never appear on the same row, so they are the same slot,
  // wide enough for whichever of the two is on screen.
  const wantSpark = value && any(packages, (p) => p.series.length)
  const wantRating = value && any(extensions, (p) => p.rating)
  const blockWidth = Math.max(wantSpark ? sparkWidth + 2 : 0, wantRating ? RATING : 0)
  const block = take(blockWidth, blockWidth > 0) ? blockWidth : 0

  return {
    name,
    value,
    src,
    stars,
    block,
    spark: block && wantSpark ? sparkWidth : 0,
    rating: Boolean(block && wantRating),
    version: take(
      10,
      any(projects, (p) => p.drift.version ?? p.drift.versions),
    ),
    age: take(10),
  }
}

type Columns = ReturnType<typeof layout>

/** Which stores a project is on, one fixed slot each so the column reads vertically. */
function sources(project: Project): string {
  return SOURCE_SLOTS.map((slot) =>
    project.targets.some((t) => t.ecosystem === slot.ecosystem) ? slot.letter : ' ',
  ).join('')
}

function open(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
}

/** A bucket is marked so nobody reads Google's rounded label as a count. */
/** Version drift is the worse news of the two, so it wins the one glyph available. */
function driftMarker(project: Project): string {
  if (project.drift.versions) return DRIFT.versions
  if (project.drift.unreleased) return DRIFT.unreleased
  return DRIFT.none
}

/**
 * Two stores disagreeing have no single version to print, and printing either one is
 * how a reader concludes the other shipped too. The detail pane names both.
 */
function versionCell(project: Project): string {
  if (project.drift.versions) return 'differs'
  return project.drift.version ?? ''
}

function reachCell(reach: Reach | null): string {
  // Blank, not a dash. A listing with no published count has nothing to be missing, and a
  // column of dashes reads as a column of failures.
  if (!reach) return ''
  return reach.bucket ? `${reach.label}~` : reach.label
}

function ratingCell(rating: Rating | null): string {
  if (!rating) return ''
  const letter = SOURCE_SLOTS.find((slot) => slot.ecosystem === rating.source)?.letter ?? '?'
  return `${letter} ${rating.score} (${rating.count})`
}

/** What a package is measured by: a week of downloads, its delta and ninety days of trace. */
function PackageCells({ project, cols }: { project: Project; cols: Columns }) {
  const downloads = project.downloads
  return (
    <>
      <Metric
        text={downloads ? compactNumber(downloads.value) : '-'}
        delta={downloads?.delta}
        width={VALUE}
        trail={DELTA}
      />
      {cols.block ? (
        <Box width={cols.block} flexShrink={0}>
          {cols.spark ? (
            <Box marginLeft={2}>
              <Sparkline
                values={project.series.map((point) => point.downloads)}
                width={cols.spark}
                color={theme.accent}
              />
            </Box>
          ) : null}
        </Box>
      ) : null}
    </>
  )
}

/**
 * What an extension is measured by. A Chrome bucket has no delta to show and never will:
 * subtracting two rounded labels measures the boundary moving, not the extension.
 */
function ExtensionCells({ project, cols }: { project: Project; cols: Columns }) {
  const reach = project.reach
  return (
    <>
      <Metric
        text={reach ? reachCell(reach) : '-'}
        delta={reach && !reach.bucket ? reach.delta : undefined}
        width={VALUE}
        trail={DELTA}
      />
      {cols.block ? (
        <Box width={cols.block} flexShrink={0} justifyContent="flex-end">
          <Text color={theme.muted}>{cols.rating ? ratingCell(project.rating) : ''}</Text>
        </Box>
      ) : null}
    </>
  )
}

function Row({
  project,
  selected,
  width,
  cols,
}: {
  project: Project
  selected: boolean
  width: number
  cols: Columns
}) {
  const marker = project.changed ? MARKERS.changed : project.stale ? MARKERS.stale : MARKERS.quiet
  const drift = driftMarker(project)
  const stars = project.stars
  const newest = project.targets.reduce(
    (latest, target) => (target.fetchedAt > latest ? target.fetchedAt : latest),
    project.targets[0]!.fetchedAt,
  )

  return (
    <Box width={width}>
      <Text color={selected ? theme.accent : undefined} inverse={selected}>
        {' '}
        {marker}
      </Text>
      <Text color={drift === DRIFT.none ? undefined : theme.warn} inverse={selected}>
        {drift}{' '}
      </Text>
      <Text bold={selected}>{project.name.slice(0, cols.name).padEnd(cols.name)}</Text>
      {cols.src ? <Text color={theme.muted}>{` ${sources(project)}`}</Text> : null}
      {cols.value ? (
        project.kind === 'extension' ? (
          <ExtensionCells project={project} cols={cols} />
        ) : (
          <PackageCells project={project} cols={cols} />
        )
      ) : null}
      {cols.stars ? (
        <Text>
          {'   '}
          <Metric
            text={stars ? `${stars.value}` : '-'}
            delta={stars?.delta}
            width={STARS}
            trail={STARS_DELTA}
          />
        </Text>
      ) : null}
      {cols.version ? (
        <Text color={project.drift.versions ? theme.warn : theme.muted}>
          {`  ${versionCell(project)}`.padStart(10)}
        </Text>
      ) : null}
      {cols.age ? <Text color={theme.muted}>{`  ${relativeAge(newest)}`.padStart(10)}</Text> : null}
    </Box>
  )
}

function Header({
  projects,
  total,
  view,
  baselineAt,
  width,
}: {
  projects: Project[]
  total: number
  view: View
  baselineAt: string | undefined
  width: number
}) {
  const changed = projects.filter((p) => p.changed).length
  const targets = projects.reduce((sum, p) => sum + p.targets.length, 0)
  const newest = projects
    .flatMap((p) => p.targets.map((t) => t.fetchedAt))
    .reduce((latest, at) => (at > latest ? at : latest), '')
  // A filtered list must never read like the whole portfolio, so the count says so and
  // the chips name every narrowing that is in force.
  const filtered = projects.length !== total
  const chips = [
    view.query ? `/${view.query}` : '',
    view.scope === 'all' ? '' : view.scope,
    view.sort === 'default' ? '' : `by ${view.sort}`,
  ].filter(Boolean)

  return (
    <Box width={width}>
      <Box flexShrink={0}>
        <Text color={theme.heading} bold>
          {' QUADRAPLEX '}
        </Text>
      </Box>
      {chips.length > 0 ? (
        <Box flexShrink={0}>
          <Text color={theme.warn}>{`${chips.join(' ')} `}</Text>
        </Box>
      ) : null}
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text color={theme.muted} wrap="truncate-end">
          {targets} targets in {filtered ? `${projects.length} of ${total}` : projects.length}
          {' projects, '}
          {changed} changed
          {newest ? `, refreshed ${relativeAge(newest)}` : ''}
          {baselineAt ? `, deltas${since(baselineAt)}` : ''}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * One table's column names, with the table's own name where PROJECT would go: the header
 * row is also the divider that says which of the two tables starts here, and which unit
 * the numbers below it are in.
 */
function columnHeader(kind: Kind, cols: Columns): string {
  const pkg = kind === 'package'
  return [
    '    ',
    (pkg ? 'PACKAGES' : 'EXTENSIONS').padEnd(cols.name).slice(0, cols.name),
    cols.src ? ` ${SOURCE_HEADER}` : '',
    cols.value ? (pkg ? 'WEEK' : 'USERS').padStart(VALUE).padEnd(VALUE + DELTA) : '',
    cols.block ? blockHeader(pkg, cols) : '',
    cols.stars ? `   ${'STARS'.padStart(STARS).padEnd(STARS + STARS_DELTA)}` : '',
    cols.version ? '  VERSION'.padStart(10) : '',
    cols.age ? '  FETCHED'.padStart(10) : '',
  ].join('')
}

function blockHeader(pkg: boolean, cols: Columns): string {
  if (!pkg) return (cols.rating ? 'RATING' : '').padStart(cols.block)
  return (cols.spark ? '90d'.padStart(cols.spark + 2) : '').padEnd(cols.block)
}

/** A header row, a blank separator, or a project. What the list window slides over. */
type ListLine = { key: string; section: Kind; project?: Project; header?: boolean }

/**
 * The two tables in one flow, so the window that scrolls the list scrolls the headers
 * with it and the cursor keeps a single index into `projects`.
 */
function listLines(projects: Project[]): ListLine[] {
  const lines: ListLine[] = []
  let section: Kind | null = null
  for (const project of projects) {
    if (project.kind !== section) {
      section = project.kind
      if (lines.length > 0) lines.push({ key: `gap:${section}`, section })
      lines.push({ key: `head:${section}`, section, header: true })
    }
    lines.push({ key: project.key, section, project })
  }
  return lines
}

/**
 * Only what the frame can actually show. A legend for a column the terminal dropped is
 * one more thing to read and nothing to look at.
 */
function legend(): string {
  return [
    `${MARKERS.changed} changed`,
    `${MARKERS.stale} stale`,
    `${DRIFT.versions} stores differ`,
    `${DRIFT.unreleased} unreleased`,
    '? explains the rest',
  ].join('   ')
}

/** The keys worth naming on one line. The rest live behind "?" and stay there. */
function keys(view: View): string {
  const parts = ['j/k move', '/ filter', 'e store', 's sort']
  parts.push(view.scope === 'all' ? 'r refresh' : `r refresh ${view.scope}`)
  if (view.query || view.scope !== 'all' || view.sort !== 'default') parts.push('c clear')
  return ` ${parts.join('   ')}   ? keys   q quit`
}

export function App({ onRefresh }: { onRefresh?: (scope: View['scope']) => Promise<void> }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = Math.max(stdout?.columns ?? 80, 40)
  const rows = Math.max((stdout?.rows ?? 24) - 7, 3)

  const [all, setAll] = useState<Project[]>(() => buildProjects())
  const [cursor, setCursor] = useState(0)
  const [pane, setPane] = useState<'list' | 'detail' | 'item' | 'help'>('list')
  const [view, setView] = useState<View>(DEFAULT_VIEW)
  const [typing, setTyping] = useState<string | null>(null)
  const [detailCursor, setDetailCursor] = useState(0)
  const [scroll, setScroll] = useState(0)
  // Its own scroll and its own way back, so reading the keys never costs the reader the
  // place they were reading from.
  const [help, setHelp] = useState<{ from: 'list' | 'detail' | 'item'; scroll: number } | null>(
    null,
  )
  const [busy, setBusy] = useState<string | null>(null)

  const projects = useMemo(() => applyView(all, view), [all, view])
  // Against what is on screen, so scoping to one store drops the columns the rest of the
  // portfolio was paying for.
  const cols = useMemo(() => layout(width, projects), [width, projects])

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
    setAll(buildProjects())
  }, [])

  /**
   * The dashboard never fetches. It shells out to the same CLI so the "breadth comes
   * from cache" rule holds for humans exactly as it does for agents, and it refreshes
   * whatever the list is scoped to: refetching 62 targets to see one Chrome listing move
   * is a request budget spent on rows nobody is looking at.
   */
  const runRefresh = useCallback(
    async (scope: View['scope']) => {
      setBusy(scope === 'all' ? 'refreshing' : `refreshing ${scope}`)
      await (onRefresh
        ? onRefresh(scope)
        : new Promise<void>((resolve) => {
            const args = scope === 'all' ? ['refresh'] : ['refresh', '--only', scope]
            const child = spawn(process.execPath, [process.argv[1]!, ...args], { stdio: 'ignore' })
            child.on('exit', () => resolve())
            child.on('error', () => resolve())
          }))
      setBusy(null)
      reload()
    },
    [onRefresh, reload],
  )

  useInput((input, key) => {
    // A filter is a text field for as long as it is open, so nothing below it can steal a
    // letter. Escape restores what was showing before, which is the only way back from a
    // query that matched nothing.
    if (typing !== null) {
      if (key.escape) {
        setView((v) => ({ ...v, query: typing }))
        return setTyping(null)
      }
      if (key.return) return setTyping(null)
      if (key.backspace || key.delete) {
        return setView((v) => ({ ...v, query: v.query.slice(0, -1) }))
      }
      if (input && !key.ctrl && !key.meta) setView((v) => ({ ...v, query: v.query + input }))
      return
    }

    // Anything but a scroll leaves, because a reader who lands here by accident should
    // not have to read the page to find the way out.
    if (pane === 'help' && help) {
      if (input === 'j' || key.downArrow) return setHelp({ ...help, scroll: help.scroll + 1 })
      if (input === 'k' || key.upArrow) {
        return setHelp({ ...help, scroll: Math.max(help.scroll - 1, 0) })
      }
      setPane(help.from)
      return setHelp(null)
    }

    if (input === 'q' || key.escape) {
      if (pane === 'item') return setPane('detail')
      if (pane === 'detail') return setPane('list')
      return exit()
    }
    if (busy) return

    if (input === '?' && pane !== 'help') {
      setHelp({ from: pane, scroll: 0 })
      return setPane('help')
    }

    const down = input === 'j' || key.downArrow
    const up = input === 'k' || key.upArrow

    if (pane === 'item') {
      if (down) setScroll((s) => s + 1)
      if (up) setScroll((s) => Math.max(s - 1, 0))
      if (input === 'o' && item) open(item.url)
      return
    }

    if (pane === 'detail') {
      if (down) setDetailCursor((c) => Math.min(c + 1, Math.max(focus.length - 1, 0)))
      if (up) setDetailCursor((c) => Math.max(c - 1, 0))
      if (key.return && item) {
        setScroll(0)
        setPane('item')
      }
      if (input === 'o' && current) open(current.url)
      return
    }

    if (down) setCursor(Math.min(index + 1, projects.length - 1))
    if (up) setCursor(Math.max(index - 1, 0))
    if (input === 'g') setCursor(0)
    if (input === 'G') setCursor(projects.length - 1)
    if (input === '/') {
      setTyping(view.query)
      setView((v) => ({ ...v, query: '' }))
    }
    // Every narrowing sends the cursor home. Leaving it at row 19 of a list that just
    // became four rows long is how a keystroke looks like a crash.
    if (input === 'e') {
      setCursor(0)
      setView((v) => ({ ...v, scope: SCOPES[(SCOPES.indexOf(v.scope) + 1) % SCOPES.length]! }))
    }
    if (input === 's') {
      setCursor(0)
      setView((v) => ({ ...v, sort: SORTS[(SORTS.indexOf(v.sort) + 1) % SORTS.length]! }))
    }
    if (input === 'c') {
      setCursor(0)
      setView(DEFAULT_VIEW)
    }
    if (key.return) {
      setDetailCursor(0)
      setPane('detail')
    }
    if (input === 'o' && selected) open(homeUrl(selected))
    if (input === 'r') void runRefresh(view.scope)
  })

  // One line more than the panes get, because the column names moved down into the body
  // and the summary above it is a single line.
  const listRows = rows + 1
  const window = useMemo(() => {
    const lines = listLines(projects)
    const at = lines.findIndex((line) => line.project === selected)
    const start = Math.max(
      0,
      Math.min(at < 0 ? 0 : at - Math.floor(listRows / 2), lines.length - listRows),
    )
    const visible = lines.slice(start, start + listRows)
    // A window that scrolled past a header redraws it on its own first row. Two tables
    // share this grid, and a column of numbers with nothing naming it is unreadable.
    const first = visible[0]
    if (first?.project)
      visible[0] = { key: `head:${first.section}`, section: first.section, header: true }
    return visible
  }, [projects, selected, listRows])

  if (all.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.heading}>QUADRAPLEX</Text>
        <Text>The store is empty. Press r to refresh, or run "qplex refresh".</Text>
        <Text color={theme.muted}>{busy ?? 'q quit'}</Text>
      </Box>
    )
  }

  if (pane === 'help' && help) return <Help offset={help.scroll} width={width} rows={rows} />
  if (pane === 'item' && item) return <Item item={item} offset={scroll} width={width} rows={rows} />
  if (pane === 'detail' && selected) {
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
      <Header
        projects={projects}
        total={all.length}
        view={view}
        baselineAt={selected?.downloads?.baselineAt}
        width={width}
      />
      {projects.length === 0 ? (
        <Text color={theme.muted}>
          {`  nothing matches. c clears the filter, ${all.length} projects are in the store.`}
        </Text>
      ) : null}
      {window.map((line) =>
        line.header ? (
          <Text key={line.key} color={theme.heading} wrap="truncate-end">
            {columnHeader(line.section, cols)}
          </Text>
        ) : line.project ? (
          <Row
            key={line.key}
            project={line.project}
            selected={line.project.key === selected?.key}
            width={width}
            cols={cols}
          />
        ) : (
          <Text key={line.key}> </Text>
        ),
      )}
      <Box marginTop={1} width={width}>
        <Text color={theme.muted} wrap="truncate-end">
          {busy ? `${busy}...` : legend()}
        </Text>
      </Box>
      <Box width={width}>
        {typing === null ? (
          <Text color={theme.muted} wrap="truncate-end">
            {keys(view)}
          </Text>
        ) : (
          <Text wrap="truncate-end">
            {' /'}
            {view.query}
            <Text inverse> </Text>
            <Text color={theme.muted}>{'   enter keep   esc cancel'}</Text>
          </Text>
        )}
      </Box>
    </Box>
  )
}
