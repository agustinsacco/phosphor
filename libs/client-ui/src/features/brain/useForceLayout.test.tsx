// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockBrainData } from './mockBrainData'
import { graphEdges, LINK_DISTANCE, type GraphEdge } from './graphLayout'
import { useForceLayout, type ForceLayout } from './useForceLayout'
import type { BrainEntity } from '@shared/brain'

let root: Root
let layout: ForceLayout
let frames: Map<number, FrameRequestCallback>
let serial: number
let raf: ReturnType<typeof vi.fn>
let entities: BrainEntity[]
let edges: GraphEdge[]

function Harness({
  data = entities,
  links = edges,
}: {
  data?: BrainEntity[]
  links?: GraphEdge[]
}): null {
  layout = useForceLayout(data, links)
  return null
}
function flushFrame(): void {
  const callbacks = [...frames.values()]
  frames.clear()
  act(() => callbacks.forEach((callback) => callback(serial * 16)))
}
function settle(): number {
  let count = 0
  while (frames.size && count < 310) {
    flushFrame()
    count++
  }
  return count
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  frames = new Map()
  serial = 0
  raf = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++serial, callback)
    return serial
  })
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id)),
  )
  const data = mockBrainData()
  entities = data.entities
  edges = graphEdges(data.details.map((detail) => detail.memory))
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it('animates while cooling, stops scheduling when settled, and reheats on drag', () => {
  act(() => root.render(<Harness />))
  const before = layout.nodes.map((node) => ({ ...node }))
  expect(layout.settled).toBe(false)
  expect(settle()).toBeGreaterThanOrEqual(300)
  expect(layout.settled).toBe(true)
  expect(frames.size).toBe(0)
  expect(layout.nodes).not.toEqual(before)
  const calls = raf.mock.calls.length
  flushFrame()
  expect(raf).toHaveBeenCalledTimes(calls)
  act(() => layout.pin('harbor', { x: 500, y: 100 }))
  expect(layout.settled).toBe(false)
  expect(frames.size).toBe(1)
  flushFrame()
  expect(layout.nodes.find((node) => node.id === 'harbor')).toMatchObject({
    x: 500,
    y: 100,
    fx: 500,
    fy: 100,
  })
  act(() => layout.release('harbor'))
  expect(layout.nodes.find((node) => node.id === 'harbor')!.fx).toBeUndefined()
  settle()
  expect(frames.size).toBe(0)
})

it('retains coordinates across refresh and starts a new node next to its linked neighbour', () => {
  act(() => root.render(<Harness />))
  settle()
  const before = layout.nodes.map((node) => ({ ...node }))
  const tom = { ...entities[0]!, id: 'tom', label: 'Tom Lee' }
  act(() =>
    root.render(
      <Harness data={[...entities, tom]} links={[...edges, { source: 'tom', target: 'harbor' }]} />,
    ),
  )
  for (const node of before) {
    const refreshed = layout.nodes.find((item) => item.id === node.id)!
    expect({ x: refreshed.x, y: refreshed.y }).toEqual({ x: node.x, y: node.y })
  }
  const added = layout.nodes.find((node) => node.id === 'tom')!
  const harbor = before.find((node) => node.id === 'harbor')!
  expect(Math.hypot(added.x - harbor.x, added.y - harbor.y)).toBeLessThan(LINK_DISTANCE)
  expect(frames.size).toBe(1)
})

it('settles synchronously without scheduling any animation under reduced motion', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  act(() => root.render(<Harness />))
  expect(layout.settled).toBe(true)
  expect(raf).not.toHaveBeenCalled()
  act(() => layout.pin('harbor', { x: 500, y: 100 }))
  expect(layout.nodes.find((node) => node.id === 'harbor')).toMatchObject({ x: 500, y: 100 })
  act(() => layout.release('harbor'))
  expect(layout.settled).toBe(true)
  expect(raf).not.toHaveBeenCalled()
})

it('cancels a pending frame on unmount', () => {
  act(() => root.render(<Harness />))
  expect(frames.size).toBe(1)
  act(() => root.unmount())
  expect(frames.size).toBe(0)
  expect(cancelAnimationFrame).toHaveBeenCalled()
})

it('does not schedule frames for an empty graph', () => {
  act(() => root.render(<Harness data={[]} links={[]} />))
  expect(layout.nodes).toEqual([])
  expect(layout.settled).toBe(true)
  expect(raf).not.toHaveBeenCalled()
})
