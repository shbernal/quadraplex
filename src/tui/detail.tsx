import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import type { Drift } from '../core/drift.ts'
import { formatDelta, metricLabel, metricText, relativeAge, since, span } from '../core/format.ts'
import type { IssueDetail } from '../sources/github.ts'
import type { Target } from '../core/types.ts'
import type { Project, Stargazers } from './model.ts'
import { deltaColor, theme } from './theme.ts'

/**
 * One terminal row. Every node truncates rather than wraps, so the count of lines is the
 * count of rows and the pane can be windowed by slicing.
 */
type Line = { key: string; node: ReactNode; focus?: number }

/**
 * The combined count only earns a line when the split is unknown. Showing both invites
 * the reader to treat one of them as an issue count, which is the mistake to avoid.
 */
function visibleMetrics(metrics: Target['metrics']): [string, Target['metrics'][string]][] {
  const split = metrics.openIssues !== null && metrics.openIssues !== undefined
  return Object.entries(metrics).filter(([key, value]) => {
    if (key === 'openIssuesAndPRs') return !split
    if (key === 'openIssues' || key === 'openPRs') return value !== null
    return true
  })
}

function blank(key: string): Line {
  return { key, node: <Text> </Text> }
}

function heading(key: string, text: string, note?: string): Line {
  return {
    key,
    node: (
      <Text color={theme.heading} wrap="truncate-end">
        {text}
        {note ? <Text color={theme.muted}>{`   ${note}`}</Text> : null}
      </Text>
    ),
  }
}

/**
 * Named in words at the top of the pane, because the marker in the list only says that
 * something is off. Which store is behind, and by how long, is the actionable part.
 */
function driftLines(drift: Drift): Line[] {
  const lines: Line[] = []
  if (drift.versions) {
    lines.push({
      key: 'drift:versions',
      node: (
        <Text color={theme.warn} wrap="truncate-end">
          {'stores differ         '}
          {drift.versions.map((entry) => `${entry.ecosystem} ${entry.version}`).join('   ')}
        </Text>
      ),
    })
  }
  if (drift.unreleased) {
    const { pushedAt, publishedAt } = drift.unreleased
    lines.push({
      key: 'drift:unreleased',
      node: (
        <Text color={theme.warn} wrap="truncate-end">
          {'unreleased            pushed '}
          {span(publishedAt, pushedAt)}
          {' after the last publish'}
        </Text>
      ),
    })
  }
  if (lines.length > 0) lines.push(blank('drift:gap'))
  return lines
}

function targetLines(target: Target, focus: number, selected: boolean): Line[] {
  const lines: Line[] = [
    {
      key: `${target.id}:head`,
      focus,
      node: (
        <Text wrap="truncate-end" inverse={selected}>
          <Text color={theme.accent}>{target.id}</Text>
          <Text color={theme.muted}>
            {'  '}
            {target.url}
          </Text>
        </Text>
      ),
    },
    {
      key: `${target.id}:age`,
      node: (
        <Text color={theme.muted} wrap="truncate-end">
          {'  fetched '}
          {relativeAge(target.fetchedAt)}
          {target.stale ? '  ! stale' : ''}
          {target.discovered === 'config' ? '  from config' : ''}
        </Text>
      ),
    },
  ]

  if (target.errors?.length) {
    lines.push({
      key: `${target.id}:errors`,
      node: (
        <Text color={theme.warn} wrap="truncate-end">
          {'  ! '}
          {target.errors.join('; ')}
        </Text>
      ),
    })
  }

  for (const [key, value] of visibleMetrics(target.metrics)) {
    const delta = target.deltas ? (target.deltas[key] ?? null) : null
    lines.push({
      key: `${target.id}:${key}`,
      node: (
        <Text wrap="truncate-end">
          {'  '}
          {metricLabel(key).padEnd(22)}
          <Text bold>{metricText(value)}</Text>
          {typeof value === 'number' ? (
            <Text color={deltaColor(delta)}>
              {'  '}
              {formatDelta(delta)}
              {since(target.deltaBaselineAt)}
            </Text>
          ) : null}
        </Text>
      ),
    })
  }
  return lines
}

function itemLine(item: IssueDetail, focus: number, selected: boolean): Line {
  return {
    key: item.url,
    focus,
    node: (
      <Text wrap="truncate-end" inverse={selected}>
        {' '}
        {item.kind === 'pr' ? 'PR' : ' #'}
        {String(item.number).padEnd(5)}
        {item.title}
        <Text color={theme.muted}>
          {'  '}
          {item.author}, {relativeAge(item.createdAt)}
          {item.labels.length ? `, ${item.labels.join(' ')}` : ''}
        </Text>
      </Text>
    ),
  }
}

/** Enough of the roster to see who is arriving, never enough to bury the open items. */
const ROSTER = 5

/**
 * Names, not a leaderboard. A large repo only ever has its tail harvested, so the block
 * says "recent" and never implies the roster adds up to the star count beside it.
 */
function rosterLines(stargazers: Stargazers | null, waiting: boolean): Line[] {
  if (!stargazers) {
    if (!waiting) return []
    return [
      blank('roster:gap'),
      {
        key: 'roster:waiting',
        node: (
          <Text color={theme.muted} wrap="truncate-end">
            {'recent stargazers   run "qplex refresh --curves"'}
          </Text>
        ),
      },
    ]
  }

  const shown = stargazers.people.slice(0, ROSTER)
  const more = stargazers.people.length - shown.length
  const lines: Line[] = [
    blank('roster:gap'),
    heading('roster:head', 'recent stargazers', `as of ${relativeAge(stargazers.asOf)}`),
    ...shown.map((person) => ({
      key: `roster:${person.login}`,
      node: (
        <Text wrap="truncate-end">
          {'  @'}
          {person.login.padEnd(24)}
          <Text color={theme.muted}>{`starred ${relativeAge(person.starredAt)}`}</Text>
        </Text>
      ),
    })),
  ]
  if (more > 0) {
    lines.push({
      key: 'roster:more',
      node: <Text color={theme.muted}>{`  and ${more} more on record`}</Text>,
    })
  }
  return lines
}

/**
 * The whole body is one scrolling flow. Budgeting only the open items, as an earlier
 * version did, let a project spanning several stores push its own title and footer off
 * the screen: the metrics block alone outgrows a short terminal.
 */
export function Detail({
  project,
  items,
  cursor,
  stargazers,
  waiting,
  width,
  rows,
}: {
  project: Project
  items: IssueDetail[]
  cursor: number
  stargazers: Stargazers | null
  waiting: boolean
  width: number
  rows: number
}) {
  const lines: Line[] = driftLines(project.drift)
  let focus = 0
  for (const target of project.targets) {
    if (focus > 0) lines.push(blank(`gap:${target.id}`))
    lines.push(...targetLines(target, focus, focus === cursor))
    focus += 1
  }
  if (items.length > 0) {
    lines.push(blank('items:gap'), heading('items:head', 'open items'))
    for (const item of items) {
      lines.push(itemLine(item, focus, focus === cursor))
      focus += 1
    }
  }
  lines.push(...rosterLines(stargazers, waiting))

  const height = Math.max(rows + 2, 3)
  const cursorLine = lines.findIndex((line) => line.focus === cursor)
  const start = Math.max(
    0,
    Math.min(cursorLine < 0 ? 0 : cursorLine - Math.floor(height / 2), lines.length - height),
  )
  const visible = lines.slice(start, start + height)
  const above = start
  const below = Math.max(lines.length - start - visible.length, 0)

  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.heading} bold wrap="truncate-end">
        {project.name}
        <Text color={theme.muted}>
          {above > 0 ? `   ${above} above` : ''}
          {below > 0 ? `   ${below} below` : ''}
        </Text>
      </Text>
      {visible.map((line) => (
        <Box key={line.key} width={width}>
          {line.node}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={theme.muted} wrap="truncate-end">
          {' j/k move   '}
          {items.length ? 'enter read   ' : ''}o open esc back q quit
        </Text>
      </Box>
    </Box>
  )
}

function wrapText(body: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of body.replaceAll('\r', '').split('\n')) {
    if (paragraph.length <= width) {
      lines.push(paragraph)
      continue
    }
    let current = ''
    for (const word of paragraph.split(' ')) {
      if (current.length + word.length + 1 > width) {
        lines.push(current)
        current = word
      } else current = current ? `${current} ${word}` : word
    }
    lines.push(current)
  }
  return lines
}

/** The full body in-pane, because bouncing to a browser to read one issue is the thing
 * a dashboard is supposed to save you. */
export function Item({
  item,
  offset,
  width,
  rows,
}: {
  item: IssueDetail
  offset: number
  width: number
  rows: number
}) {
  const lines = wrapText(item.body || '(no description)', width - 2)
  const visible = lines.slice(offset, offset + rows)
  const more = lines.length - offset - visible.length

  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.heading} bold wrap="truncate-end">
        {item.kind === 'pr' ? 'PR' : 'issue'} #{item.number} {item.title}
      </Text>
      <Text color={theme.muted} wrap="truncate-end">
        {item.author}, opened {relativeAge(item.createdAt)}, {item.comments} comments
        {item.draft ? ', draft' : ''}
        {item.labels.length ? `, ${item.labels.join(' ')}` : ''}
      </Text>
      <Text color={theme.muted} wrap="truncate-end">
        {item.url}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, index) => (
          <Text key={`${offset + index}`} wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {`${more > 0 ? `${more} more ${more === 1 ? 'line' : 'lines'}, j/k scroll   ` : ''}o open   esc back`}
        </Text>
      </Box>
    </Box>
  )
}
