import { Box, Text } from 'ink'
import { formatDelta, relativeAge, since } from '../core/format.ts'
import type { IssueDetail } from '../sources/github.ts'
import type { Target } from '../core/types.ts'
import type { Project, Stargazers } from './model.ts'
import { theme } from './theme.ts'

function Metrics({ project }: { project: Project }) {
  return (
    <>
      {project.targets.map((target) => (
        <Box key={target.id} flexDirection="column" marginTop={1}>
          <Text>
            <Text color={theme.accent}>{target.id}</Text>
            <Text color={theme.muted}>
              {'  '}
              {target.url}
            </Text>
          </Text>
          <Text color={theme.muted}>
            fetched {relativeAge(target.fetchedAt)}
            {target.stale ? '  ! stale' : ''}
            {target.discovered === 'config' ? '  from config' : ''}
          </Text>
          {target.errors?.length ? (
            <Text color={theme.warn}>! {target.errors.join('; ')}</Text>
          ) : null}
          {visibleMetrics(target.metrics).map(([key, value]) => {
            const delta = target.deltas ? (target.deltas[key] ?? null) : null
            return (
              <Text key={key}>
                {'  '}
                {label(key).padEnd(22)}
                <Text bold>{value === null ? '-' : String(value)}</Text>
                {typeof value === 'number' ? (
                  <Text color={delta && delta > 0 ? theme.up : theme.muted}>
                    {'  '}
                    {formatDelta(delta)}
                    {since(target.deltaBaselineAt)}
                  </Text>
                ) : null}
              </Text>
            )
          })}
        </Box>
      ))}
    </>
  )
}

/** open_issues_count includes pull requests, and the name says so wherever it is shown. */
function label(key: string): string {
  return key === 'openIssuesAndPRs' ? 'open issues + PRs' : key
}

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

/** Enough of the roster to see who is arriving, never enough to bury the open items. */
const ROSTER = 5

/**
 * Names, not a leaderboard. A large repo only ever has its tail harvested, so the block
 * says "recent" and never implies the roster adds up to the star count beside it.
 */
function Roster({ stargazers, waiting }: { stargazers: Stargazers | null; waiting: boolean }) {
  if (!stargazers) {
    return waiting ? (
      <Box marginTop={1}>
        <Text color={theme.muted}>{'recent stargazers   run "qplex refresh --curves"'}</Text>
      </Box>
    ) : null
  }
  const shown = stargazers.people.slice(0, ROSTER)
  const more = stargazers.people.length - shown.length

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.heading}>
        recent stargazers
        <Text color={theme.muted}>{`   as of ${relativeAge(stargazers.asOf)}`}</Text>
      </Text>
      {shown.map((person) => (
        <Text key={person.login} wrap="truncate-end">
          {'  @'}
          {person.login.padEnd(24)}
          <Text color={theme.muted}>{`starred ${relativeAge(person.starredAt)}`}</Text>
        </Text>
      ))}
      {more > 0 ? <Text color={theme.muted}>{`  and ${more} more on record`}</Text> : null}
    </Box>
  )
}

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
  // The roster takes a fixed slice off the top and the open items keep the rest, so a
  // long backlog cannot squeeze the names out and the names cannot bury the backlog.
  const reserved = stargazers ? Math.min(stargazers.people.length, ROSTER) + 3 : waiting ? 2 : 0
  const height = Math.max(rows - reserved, 1)
  // Scrolled rather than truncated, because a cursor the pane cannot show is a cursor the
  // reader cannot follow.
  const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), items.length - height))
  const visible = items.slice(start, start + height)

  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.heading} bold>
        {project.name}
      </Text>
      <Metrics project={project} />
      {visible.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.heading}>open items</Text>
          {visible.map((item, index) => (
            <Text key={item.url} wrap="truncate-end" inverse={start + index === cursor}>
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
          ))}
        </Box>
      ) : null}
      <Roster stargazers={stargazers} waiting={waiting} />
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {items.length ? 'j/k item   enter read   ' : ''}esc back o open q quit
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
          {more > 0 ? `${more} more lines, j/k scroll   ` : ''}esc back o open q quit
        </Text>
      </Box>
    </Box>
  )
}
