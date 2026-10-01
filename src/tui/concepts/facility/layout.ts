/**
 * How much tile the terminal can afford. The wall must show every project without
 * scrolling, so it steps down through denser tile shapes until the whole portfolio fits,
 * and only scrolls when even one-line cells overflow.
 */
export type Level = 3 | 2 | 1 | 0 | -1

/** Lines per tile, minimum and maximum width per tile, and blank rows between tile rows. */
const SHAPES: Record<Level, { lines: number; min: number; max: number; gap: number }> = {
  3: { lines: 3, min: 21, max: 30, gap: 1 },
  2: { lines: 2, min: 18, max: 26, gap: 0 },
  1: { lines: 1, min: 18, max: 24, gap: 0 },
  0: { lines: 1, min: 11, max: 14, gap: 0 },
  // A pixel per project, the heatmap the wall becomes once names no longer fit.
  [-1]: { lines: 1, min: 2, max: 2, gap: 0 },
}

export type Grid = {
  level: Level
  columns: number
  tileWidth: number
  lines: number
  gap: number
  /** Tile rows that fit at once. Smaller than the total only when the wall must scroll. */
  visibleRows: number
  totalRows: number
}

const COL_GAP = 1

export function fitGrid(count: number, width: number, height: number): Grid {
  // A tall tile drops its breathing row before it drops a line of content.
  // A one-line cell then gives up name characters, down to a stub, before the names go.
  const tries: [Level, number, number?][] = [
    [3, 1],
    [3, 0],
    [2, 0],
    [1, 0],
  ]
  for (let min = SHAPES[0].min; min >= 7; min--) tries.push([0, 0, min])
  tries.push([-1, 0])
  for (const [level, gapRows, min] of tries) {
    const shape = {
      ...SHAPES[level],
      gap: gapRows,
      ...(min ? { min, max: Math.max(min, SHAPES[0].max) } : {}),
    }
    const columns = Math.max(1, Math.floor((width + COL_GAP) / (shape.min + COL_GAP)))
    const tileWidth = Math.min(shape.max, Math.floor((width + COL_GAP) / columns) - COL_GAP)
    const totalRows = Math.ceil(count / columns)
    const needed = totalRows * shape.lines + Math.max(0, totalRows - 1) * shape.gap
    if (needed <= height || level === -1) {
      const perRow = shape.lines + shape.gap
      return {
        level,
        columns,
        tileWidth,
        lines: shape.lines,
        gap: shape.gap,
        visibleRows: Math.max(1, Math.min(totalRows, Math.floor((height + shape.gap) / perRow))),
        totalRows,
      }
    }
  }
  throw new Error('unreachable')
}

export const COLUMN_GAP = COL_GAP

export const SIDE_WIDTH = 40
const MIN_BOTTOM = 4
/** Header two lines, legend one. */
const CHROME = 3

export type Arrangement = {
  grid: Grid
  placement: 'side' | 'bottom' | 'none'
  gridWidth: number
  gridHeight: number
  /** Body lines of a bottom panel, under its rule. */
  bottomLines: number
}

function wallHeight(grid: Grid): number {
  const scroll = grid.visibleRows < grid.totalRows ? 1 : 0
  return grid.visibleRows * grid.lines + Math.max(0, grid.visibleRows - 1) * grid.gap + scroll
}

const rank = (g: Grid) => g.level * 2 + g.gap

/**
 * The panel goes wherever it costs the wall least. Beside the wall when the terminal is
 * wide enough and the tiles keep their shape there, underneath otherwise, and a bottom
 * panel absorbs whatever height the wall does not need.
 */
export function arrange(count: number, columns: number, rows: number, panel: boolean): Arrangement {
  const body = rows - CHROME
  if (!panel) {
    return {
      grid: fitGrid(count, columns, body),
      placement: 'none',
      gridWidth: columns,
      gridHeight: body,
      bottomLines: 0,
    }
  }
  const bottomGrid = fitGrid(count, columns, body - MIN_BOTTOM - 1)
  const bottomWall = wallHeight(bottomGrid)
  const bottom: Arrangement = {
    grid: bottomGrid,
    placement: 'bottom',
    gridWidth: columns,
    gridHeight: bottomWall,
    bottomLines: body - bottomWall - 1,
  }
  if (columns < 110) return bottom
  const sideWidth = columns - SIDE_WIDTH - 1
  const sideGrid = fitGrid(count, sideWidth, body)
  if (rank(sideGrid) < rank(bottomGrid)) return bottom
  return {
    grid: sideGrid,
    placement: 'side',
    gridWidth: sideWidth,
    gridHeight: body,
    bottomLines: 0,
  }
}
