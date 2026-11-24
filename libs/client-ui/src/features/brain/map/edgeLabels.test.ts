import { expect, it } from 'vitest'
import type { MapNode } from '../explorer/mapLayout'
import { placeEdgeLabels } from './edgeLabels'

const node = (id: string, x: number, y: number): MapNode => ({
  id,
  label: id,
  kind: 'person',
  memories: 1,
  x,
  y,
  r: 6,
  ring: 1,
  caption: null,
})

it('places words mid-edge, moves them off a node, and leaves out what fits nowhere', () => {
  const nodes = [node('a', 20, 100), node('b', 380, 100), node('c', 200, 100)]
  const labels = placeEdgeLabels(
    [
      { key: 'ab', text: 'reports to', x1: 20, y1: 100, x2: 380, y2: 100 },
      { key: 'dup', text: 'reports to', x1: 20, y1: 100, x2: 380, y2: 100 },
      { key: 'out', text: 'far away words', x1: 395, y1: 5, x2: 399, y2: 2 },
    ],
    nodes,
    400,
    200,
  )
  const ab = labels.get('ab')!
  // The middle is taken by node c, so the label moves along the line.
  expect(ab.x).not.toBe(200)
  expect(ab.box.y).toBeLessThan(100)
  expect(labels.get('dup')?.x).not.toBe(ab.x)
  expect(labels.has('out')).toBe(false)
})
