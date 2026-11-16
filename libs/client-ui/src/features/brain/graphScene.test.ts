// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PerspectiveCamera, type Vector2 } from 'three'
import type SpriteText from 'three-spritetext'
import { createGraphScene, type GraphScene } from './graphScene'
import { graphModel, type GraphModel, type GraphNode } from './graphModel'
import { boundedGraph, graphFixture, installGraphEnvironment } from './__fixtures__/graph3D'

const mock = await vi.hoisted(async () => {
  const { createGraphMock } = await import('./__fixtures__/graph3D')
  return createGraphMock()
})
vi.mock('3d-force-graph', () => ({ default: mock.constructor }))
vi.mock('three-spritetext', () => ({
  default: class {
    visible = true
    color = ''
    renderOrder = 0
    material = { opacity: 1, depthTest: true, sizeAttenuation: true }
    position = { y: 0, set: vi.fn() }
    // Ten times as wide as tall: 120 CSS pixels for a 12 pixel label.
    scale = { x: 60, y: 6 }
    constructor(public text: string) {}
  },
}))

const graph = mock.graph
const forces = {
  charge: { distanceMax: vi.fn() },
  link: { distance: vi.fn() },
}
let scene: GraphScene
let camera: PerspectiveCamera
let model: GraphModel
const label = (id: string): SpriteText =>
  (graph.nodeThreeObject!.mock.lastCall![0] as (node: GraphNode) => SpriteText)(
    model.nodes.find((node) => node.id === id)!,
  )
const renderer = { getSize: (size: Vector2) => size.set(800, 400) }
const frame = (): void => mock.scene.onBeforeRender?.(renderer, undefined, camera)

beforeEach(() => {
  for (const method of Object.values(graph)) method.mockReset().mockReturnValue(graph)
  mock.constructor.mockReset().mockImplementation(function () {
    return graph
  })
  delete mock.scene.onBeforeRender
  graph.scene!.mockReturnValue(mock.scene)
  graph.controls!.mockReturnValue(mock.controls)
  graph.d3Force!.mockImplementation((name: keyof typeof forces) => forces[name])
  camera = new PerspectiveCamera(40, 2, 0.1, 10000)
  camera.position.set(30, 10, 320)
  camera.updateMatrixWorld()
  graph.camera!.mockReturnValue(camera)
  graph.cameraPosition!.mockImplementation((...args: unknown[]) =>
    args.length ? graph : { x: 30, y: 10, z: 320 },
  )
  // Three nodes in a row, 30 world units apart: about 60 CSS pixels in this 800 by 400 pane.
  graph.graphData!.mockImplementation((next: GraphModel) => {
    next.nodes.forEach((node, index) => Object.assign(node, { x: index * 30, y: 10, z: 20 }))
    return graph
  })
  installGraphEnvironment()
  const sample = graphFixture()
  model = graphModel(boundedGraph(sample.entities, sample.memories))
  scene = createGraphScene(document.createElement('div'), vi.fn(), vi.fn())
})
afterEach(() => {
  scene.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps unlinked groups close together and gives linked nodes room for their labels', () => {
  expect(forces.charge.distanceMax).toHaveBeenCalledWith(90)
  expect(forces.link.distance).toHaveBeenCalledWith(45)
})

it('hides a label that would cover a more important one, on every frame', () => {
  scene.update(model, { focus: null, matches: null })
  frame()
  // Harbor has the most memories and links, so its label wins; its neighbours would cover it.
  expect(label('harbor').visible).toBe(true)
  expect(label('postgres').visible).toBe(false)
})

it('always shows the label of the selected node, whatever it covers', () => {
  scene.update(model, { focus: 'postgres', matches: null })
  frame()
  expect(label('postgres').visible).toBe(true)
  expect(label('harbor').visible).toBe(false)
})
