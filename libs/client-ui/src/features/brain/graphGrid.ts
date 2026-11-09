/** Work counters for tests: pair evaluations and simulation ticks. */
export const layoutStats = { pairs: 0, ticks: 0 }

const NEIGHBOURS = [
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const

// Cell indexes within ±2^20 pack into one safe integer key.
const OFFSET = 2 ** 20
const SPAN = 2 ** 21
function cellKey(cx: number, cy: number): number {
  return (cx + OFFSET) * SPAN + (cy + OFFSET)
}

/**
 * Visits each unordered pair of items whose cells touch, once. Cells are
 * `width` by `height`, so two items further apart than one cell on either axis
 * are never compared: a pass costs about the items times their neighbours.
 */
export function nearbyPairs<T>(
  items: T[],
  position: (item: T) => { x: number; y: number },
  width: number,
  height: number,
  visit: (a: T, b: T) => void,
): void {
  const cells = new Map<number, T[]>()
  for (const item of items) {
    const { x, y } = position(item)
    const key = cellKey(Math.floor(x / width), Math.floor(y / height))
    const cell = cells.get(key)
    if (cell) cell.push(item)
    else cells.set(key, [item])
  }
  for (const [key, cell] of cells) {
    for (let i = 0; i < cell.length; i++)
      for (let j = i + 1; j < cell.length; j++) {
        layoutStats.pairs++
        visit(cell[i]!, cell[j]!)
      }
    const cx = Math.floor(key / SPAN) - OFFSET,
      cy = (key % SPAN) - OFFSET
    for (const [dx, dy] of NEIGHBOURS) {
      const other = cells.get(cellKey(cx + dx, cy + dy))
      if (!other) continue
      for (const a of cell)
        for (const b of other) {
          layoutStats.pairs++
          visit(a, b)
        }
    }
  }
}
