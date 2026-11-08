import { expect, it } from 'vitest'
import { mockBrainData } from './mockBrainData'
import {
  fitGraph,
  graphEdges,
  layoutGraph,
  LABEL_HEIGHT,
  separateLabels,
  svgPoint,
  worldPoint,
  zoomView,
  type GraphNode,
} from './graphLayout'

it('makes deterministic finite force positions and edges only for relationships', () => {
  const { entities, details } = mockBrainData()
  const edges = graphEdges([
    ...details.map((d) => d.memory),
    { ...details[0]!.memory, objectId: null },
  ])
  expect(edges).toHaveLength(2)
  const nodes = layoutGraph(entities, edges)
  expect(nodes).toEqual(layoutGraph(entities, edges))
  expect(nodes.map((n) => n.id)).toEqual(entities.map((e) => e.id))
  expect(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
  expect(layoutGraph([], [])).toEqual([])
  expect(layoutGraph(entities.slice(0, 1), [{ source: 'missing', target: 'harbor' }])).toHaveLength(
    1,
  )
})

it('separates every intersecting label vertically, including coincident and long labels', () => {
  const nodes: GraphNode[] = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    label: 'Long entity label',
    x: (i % 3) * 10,
    y: 0,
    width: 220,
  }))
  const result = separateLabels(nodes)
  expect(nodes.every((n) => n.y === 0)).toBe(true)
  for (let i = 0; i < result.length; i++)
    for (let j = i + 1; j < result.length; j++) {
      expect(Math.abs(result[i]!.y - result[j]!.y)).toBeGreaterThanOrEqual(LABEL_HEIGHT + 8)
    }
})

it('fits all label bounds within the viewport with padding, including one node', () => {
  const { entities, details } = mockBrainData()
  for (const input of [entities, entities.slice(0, 1)]) {
    const nodes = layoutGraph(input, graphEdges(details.map((d) => d.memory)))
    const view = fitGraph(nodes)
    for (const node of nodes) {
      expect((node.x - node.width / 2) * view.scale + view.x).toBeGreaterThanOrEqual(31.99)
      expect((node.x + node.width / 2) * view.scale + view.x).toBeLessThanOrEqual(768.01)
      expect((node.y - LABEL_HEIGHT / 2) * view.scale + view.y).toBeGreaterThanOrEqual(31.99)
      expect((node.y + LABEL_HEIGHT / 2) * view.scale + view.y).toBeLessThanOrEqual(368.01)
    }
  }
  expect(fitGraph([])).toEqual({ x: 400, y: 200, scale: 1 })
})

it('zooms around the pointer without moving the world point and clamps scale', () => {
  const view = { x: 100, y: 80, scale: 2 },
    anchor = { x: 350, y: 120 }
  expect(worldPoint(anchor, zoomView(view, 1.5, anchor))).toEqual(worldPoint(anchor, view))
  expect(zoomView(view, 1e6, anchor).scale).toBe(8)
  expect(zoomView(view, 1e-6, anchor).scale).toBe(0.02)
})

it('maps pointers through SVG letterboxing and page offsets for node drag and pan', () => {
  expect(svgPoint({ x: 410, y: 410 }, { left: 10, top: 10, width: 800, height: 800 })).toEqual({
    x: 400,
    y: 200,
  })
  expect(svgPoint({ x: 810, y: 210 }, { left: 10, top: 10, width: 1600, height: 400 })).toEqual({
    x: 400,
    y: 200,
  })
})
