import { Text } from 'ink'

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/**
 * The Quadraplex T-3000 is a blue screen with a green trace, so the sparkline is the
 * signature element rather than decoration. It takes a plain number array so a star curve
 * renders through the same component without changes.
 */
export function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return ''
  const points = bucket(values, width)
  const max = Math.max(...points)
  if (max <= 0) return BLOCKS[0]!.repeat(points.length)
  return points
    .map(
      (value) =>
        BLOCKS[Math.min(BLOCKS.length - 1, Math.round((value / max) * (BLOCKS.length - 1)))]!,
    )
    .join('')
}

/** A quarter of daily counts, averaged into the columns available. */
const WINDOW_DAYS = 90

function bucket(values: number[], width: number): number[] {
  const tail = values.slice(-WINDOW_DAYS)
  if (tail.length <= width) return tail
  const size = tail.length / width
  return Array.from({ length: width }, (_, i) => {
    const slice = tail.slice(
      Math.floor(i * size),
      Math.max(Math.floor((i + 1) * size), Math.floor(i * size) + 1),
    )
    return slice.reduce((total, value) => total + value, 0) / slice.length
  })
}

export function Sparkline({
  values,
  width,
  color,
}: {
  values: number[]
  width: number
  color?: string
}) {
  const line = sparkline(values, width)
  if (!line) return <Text dimColor>{' '.repeat(width)}</Text>
  return <Text color={color}>{line.padStart(width)}</Text>
}
