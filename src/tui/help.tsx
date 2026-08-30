import { Box, Text } from 'ink'
import { DRIFT, MARKERS, SOURCE_HEADER, theme } from './theme.ts'

/**
 * Every key and every glyph in one place, so the footer can stay one line wide enough to
 * survive an eighty column terminal instead of listing them all and truncating.
 */
const PAGE: [string, string][] = [
  ['', 'list'],
  ['j k', 'move, arrows work too'],
  ['g G', 'first, last'],
  ['enter', 'open the project'],
  ['o', 'open the project home page in a browser'],
  ['/', 'filter by project name or target id'],
  ['e', 'cycle the ecosystem scope'],
  ['s', 'cycle the sort: what moved, drift, downloads, stars, name, age'],
  ['c', 'clear the filter, the scope and the sort'],
  ['r', 'refresh, scoped to the ecosystem in force'],
  ['q', 'quit'],
  ['', ''],
  ['', 'project'],
  ['j k', 'move over the stores and the open items'],
  ['enter', 'read an open item without leaving the terminal'],
  ['o', 'open whatever the cursor is on'],
  ['esc', 'back'],
  ['', ''],
  ['', 'markers'],
  [MARKERS.changed, 'something moved since the delta baseline'],
  [MARKERS.stale, 'older than its ecosystem TTL'],
  [DRIFT.versions, 'two stores publish different versions'],
  [DRIFT.unreleased, 'pushed more than a day after the newest release'],
  ['~', 'a rounded bucket, not a count. Google publishes nothing finer'],
  [SOURCE_HEADER, 'one slot per store, in that order'],
  ['new', 'no snapshot old enough to subtract. Unknown, never zero'],
  ['', ''],
  ['', 'columns'],
  ['WEEK', 'downloads over seven days, summed across the registries'],
  ['USERS', 'the Chrome install bucket, or Firefox daily users. Never both'],
  ['VERSION', 'the version every store agrees on'],
  ['the trace', 'ninety days of daily downloads'],
]

export function Help({ offset, width, rows }: { offset: number; width: number; rows: number }) {
  const lines = PAGE.map(([key, text]) => (key ? `  ${key.padEnd(10)}${text}` : text ? text : ''))
  const visible = lines.slice(offset, offset + rows)
  const more = lines.length - offset - visible.length

  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.heading} bold>
        QUADRAPLEX
      </Text>
      {visible.map((line, index) => (
        <Text
          key={`${offset + index}`}
          color={line && !line.startsWith(' ') ? theme.heading : undefined}
          wrap="truncate-end"
        >
          {line || ' '}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {`${more > 0 ? `${more} more ${more === 1 ? 'line' : 'lines'}, j/k scroll   ` : ''}any other key returns`}
        </Text>
      </Box>
    </Box>
  )
}
