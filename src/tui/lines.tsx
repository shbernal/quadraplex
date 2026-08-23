import { Box, Text } from 'ink'
import type { Line } from './cells.ts'

/** Draws a frame of styled segments, one Ink text per line. */
export function Lines({ lines, cols, rows }: { lines: Line[]; cols: number; rows: number }) {
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* oxlint-disable react/no-array-index-key -- a frame is a fixed grid, position is identity */}
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
