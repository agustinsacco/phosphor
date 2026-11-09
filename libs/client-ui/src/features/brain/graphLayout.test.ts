import { expect, it } from 'vitest'
import { mockBrainData } from './mockBrainData'
import {
  fitGraph,
  graphEdges,
  layoutGraph,
  labelBox,
  createSimulation,
  tickSimulation,
  settleSimulation,
  ALPHA_MIN,
  LINK_DISTANCE,
  svgPoint,
  worldPoint,
  zoomView,
  layoutStats,
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

it('settles a sparse 30-node graph without intersecting circle or label bounds', () => {
  const { entities } = mockBrainData()
  const fixture = Array.from({ length: 30 }, (_, i) => ({
    ...entities[0]!,
    id: `harbor-${i}`,
    label: `Harbor billing service ${i}`,
  }))
  const simulation = createSimulation(fixture, [
    { source: 'harbor-0', target: 'harbor-1' },
    { source: 'harbor-1', target: 'harbor-2' },
  ])
  let ticks = 0
  while (simulation.alpha > ALPHA_MIN && ticks < 301) {
    tickSimulation(simulation)
    ticks++
  }
  expect(simulation.alpha).toBeLessThanOrEqual(ALPHA_MIN)
  expect(ticks).toBeLessThanOrEqual(301)
  const spanX =
    Math.max(...simulation.nodes.map((n) => n.x)) - Math.min(...simulation.nodes.map((n) => n.x))
  const spanY =
    Math.max(...simulation.nodes.map((n) => n.y)) - Math.min(...simulation.nodes.map((n) => n.y))
  expect(spanY / spanX).toBeLessThan(2)
  const boxes = simulation.nodes.map(labelBox)
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!,
        b = boxes[j]!
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(
        true,
      )
    }
})

it('fits all label bounds within the viewport with padding, including one node', () => {
  const { entities, details } = mockBrainData()
  for (const input of [entities, entities.slice(0, 1)]) {
    const nodes = layoutGraph(input, graphEdges(details.map((d) => d.memory)))
    const view = fitGraph(nodes)
    for (const node of nodes) {
      const box = labelBox(node)
      expect(box.left * view.scale + view.x).toBeGreaterThanOrEqual(31.99)
      expect(box.right * view.scale + view.x).toBeLessThanOrEqual(768.01)
      expect(box.top * view.scale + view.y).toBeGreaterThanOrEqual(31.99)
      expect(box.bottom * view.scale + view.y).toBeLessThanOrEqual(368.01)
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

it('caps the label footprint instead of expanding long entities into oversized pills', () => {
  const { entities } = mockBrainData()
  const nodes = layoutGraph([{ ...entities[0]!, label: 'Harbor billing service '.repeat(4) }], [])
  expect(nodes[0]!.width).toBeLessThan(260)
})

it('holds pinned coordinates while linked neighbours follow the dragged node', () => {
  const { entities, details } = mockBrainData()
  const simulation = createSimulation(entities, graphEdges(details.map((d) => d.memory)))
  settleSimulation(simulation)
  const node = simulation.nodes[0]!
  const neighbor = simulation.nodes[1]!
  const previous = { x: neighbor.x, y: neighbor.y }
  node.x = node.fx = 450
  node.y = node.fy = 120
  simulation.alpha = 0.3
  settleSimulation(simulation)
  expect({ x: node.x, y: node.y }).toEqual({ x: 450, y: 120 })
  expect({ x: neighbor.x, y: neighbor.y }).not.toEqual(previous)
  expect(Math.hypot(neighbor.x - node.x, neighbor.y - node.y)).toBeLessThan(
    Math.hypot(previous.x - node.x, previous.y - node.y),
  )
})

it('preserves existing positions and seeds new entities near a linked neighbour on refresh', () => {
  const { entities } = mockBrainData()
  const previous = layoutGraph(entities, [])
  const added = { ...entities[0]!, id: 'tom', label: 'Tom Lee', kind: 'person' as const }
  const simulation = createSimulation(
    [...entities, added],
    [{ source: 'harbor', target: 'tom' }],
    previous,
  )
  for (const old of previous) {
    const node = simulation.nodes.find((item) => item.id === old.id)!
    expect({ x: node.x, y: node.y }).toEqual({ x: old.x, y: old.y })
  }
  const node = simulation.nodes.find((item) => item.id === 'tom')!
  const harbor = previous.find((item) => item.id === 'harbor')!
  expect(Math.hypot(node.x - harbor.x, node.y - harbor.y)).toBeLessThan(LINK_DISTANCE)
  const isolated = createSimulation([...entities, added], [], previous).nodes.at(-1)!
  expect(Math.hypot(isolated.x, isolated.y)).toBeLessThan(LINK_DISTANCE)
})

it('seeds by id independently of input order', () => {
  const { entities } = mockBrainData()
  const a = createSimulation(entities, []).nodes
  const b = createSimulation([...entities].reverse(), []).nodes.reverse()
  expect(a).toEqual(b)
})

it('maps pointer coordinates using a measured tall viewport', () => {
  expect(
    svgPoint(
      { x: 210, y: 610 },
      { left: 10, top: 10, width: 400, height: 900 },
      { width: 400, height: 900 },
    ),
  ).toEqual({ x: 200, y: 600 })
})

function largeGraph(n: number) {
  const { entities } = mockBrainData()
  const nodes = Array.from({ length: n }, (_, i) => ({
    ...entities[0]!,
    id: `harbor-${i}`,
    label: i % 3 ? `Rina Okafor ${i}` : `Harbor billing service ${i}`,
  }))
  const edges = nodes
    .slice(1)
    .flatMap((node, i) => (i % 2 ? [] : [{ source: `harbor-${i}`, target: node.id }]))
  return createSimulation(nodes, edges)
}

it('compares only nearby nodes, so a 400-node tick costs far less than every pair', () => {
  const simulation = largeGraph(400)
  settleSimulation(simulation)
  simulation.alpha = 0.3
  layoutStats.pairs = 0
  tickSimulation(simulation)
  // One repulsion pass and eight collision passes over every pair would be 9 * n(n-1)/2.
  expect(layoutStats.pairs).toBeLessThan(0.15 * 9 * ((400 * 399) / 2))
  const boxes = simulation.nodes.map(labelBox)
  let overlaps = 0
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!,
        b = boxes[j]!
      if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top))
        overlaps++
    }
  expect(overlaps).toBe(0)
})
