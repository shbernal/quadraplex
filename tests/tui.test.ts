import { expect, test } from 'bun:test'
import { sparkline } from '../src/tui/sparkline.tsx'

test('a sparkline scales to its own maximum and fits the width it is given', () => {
  expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8)).toBe('▁▂▃▄▅▆▇█')
  expect(sparkline([1, 1, 1], 3)).toBe('███')
  expect(sparkline([0, 0, 0], 3)).toBe('▁▁▁')
  expect(
    sparkline(
      Array.from({ length: 90 }, (_, i) => i),
      10,
    ),
  ).toHaveLength(10)
})

test('an empty series renders nothing rather than a misleading flat line', () => {
  expect(sparkline([], 10)).toBe('')
  expect(sparkline([1, 2, 3], 0)).toBe('')
})
