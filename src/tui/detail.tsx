import { Box, Text } from 'ink'
import { formatDelta, relativeAge, since } from '../core/format.ts'
import type { Project } from './model.ts'
import { theme } from './theme.ts'

export function Detail({ project, width }: { project: Project; width: number }) {
  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.heading} bold>
        {project.name}
      </Text>
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
          {Object.entries(target.metrics).map(([key, value]) => {
            const delta = target.deltas ? (target.deltas[key] ?? null) : null
            return (
              <Text key={key}>
                {'  '}
                {key.padEnd(16)}
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
      <Box marginTop={1}>
        <Text color={theme.muted}>esc back o open q quit</Text>
      </Box>
    </Box>
  )
}
