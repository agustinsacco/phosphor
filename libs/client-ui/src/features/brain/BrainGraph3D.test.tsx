// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type SpriteText from 'three-spritetext'
import type { BrainEntity, BrainMemory } from '@shared/brain'
import type { GraphLink, GraphModel, GraphNode } from './graphModel'
import { BrainGraph3D } from './BrainGraph3D'
import { mockBrainData } from './mockBrainData'

const mock = vi.hoisted(() => {
  const names = [
    'backgroundColor',
    'showNavInfo',
    'nodeLabel',
    'linkLabel',
    'nodeVal',
    'nodeRelSize',
    'nodeOpacity',
    'linkOpacity',
    'linkWidth',
    'nodeThreeObjectExtend',
    'linkThreeObjectExtend',
    'nodeThreeObject',
    'linkThreeObject',
    'linkPositionUpdate',
    'nodeColor',
    'linkColor',
    'onNodeClick',
    'onNodeHover',
    'onNodeDrag',
    'onNodeDragEnd',
    'onEngineStop',
    'warmupTicks',
    'cooldownTicks',
    'd3ReheatSimulation',
    'width',
    'height',
    'graphData',
    'zoomToFit',
    'cameraPosition',
    'controls',
    'pauseAnimation',
    'resumeAnimation',
    '_destructor',
  ] as const
  const graph = Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<
    (typeof names)[number],
    ReturnType<typeof vi.fn>
  >
  const controls = {
    target: { x: 0, y: 0, z: 0 },
    enableDamping: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  const constructor = vi.fn(function () {
    return graph
  })
  return { graph, controls, constructor }
})
vi.mock('3d-force-graph', () => ({ default: mock.constructor }))
vi.mock('three-spritetext', () => ({
  default: class {
    visible = true
    color = ''
    material = { opacity: 1 }
    position = { y: 0, set: vi.fn() }
    constructor(public text: string) {}
  },
}))

let root: Root
let container: HTMLDivElement
let entities: BrainEntity[]
let memories: BrainMemory[]
let resize: () => void
let disconnect: ReturnType<typeof vi.fn>
const onFocus = vi.fn()
const graph = mock.graph
function setting<T>(name: keyof typeof graph): T {
  return graph[name].mock.lastCall![0] as T
}
const data = (): GraphModel => setting('graphData')
const nodeColor = (id: string): string =>
  setting<(node: GraphNode) => string>('nodeColor')(data().nodes.find((node) => node.id === id)!)
const sprite = (id: string): SpriteText =>
  setting<(node: GraphNode) => SpriteText>('nodeThreeObject')(
    data().nodes.find((node) => node.id === id)!,
  )
const hover = (id: string | null): void =>
  setting<(node: GraphNode | null) => void>('onNodeHover')(
    data().nodes.find((node) => node.id === id) ?? null,
  )

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const method of Object.values(graph)) method.mockReset().mockReturnValue(graph)
  mock.constructor.mockReset().mockImplementation(function () {
    return graph
  })
  mock.controls.addEventListener.mockReset()
  mock.controls.removeEventListener.mockReset()
  graph.controls.mockReturnValue(mock.controls)
  graph.cameraPosition.mockImplementation((...args: unknown[]) =>
    args.length ? graph : { x: 0, y: 0, z: 300 },
  )
  graph.graphData.mockImplementation((model: GraphModel) => {
    model.nodes.forEach((node, index) => {
      node.x = index * 30
      node.y = 10
      node.z = 20
    })
    return graph
  })
  onFocus.mockReset()
  const sample = mockBrainData()
  entities = sample.entities
  memories = sample.details.map((detail) => detail.memory)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    getExtension: () => null,
  } as unknown as WebGL2RenderingContext)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 400,
  } as DOMRect)
  disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  for (const [name, color] of Object.entries({
    accent: '#b35c0f',
    text: '#26262a',
    'text-secondary': '#666666',
    'border-strong': '#c9c9ce',
  }))
    document.documentElement.style.setProperty(`--px-${name}`, color)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.documentElement.removeAttribute('style')
  document.documentElement.classList.remove('dark')
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(
  props: { focus?: string | null; matches?: Set<string> | null } = {},
): Promise<void> {
  await act(async () =>
    root.render(
      <BrainGraph3D
        entities={entities}
        memories={memories}
        focus={props.focus ?? null}
        matches={props.matches ?? null}
        onFocus={onFocus}
      />,
    ),
  )
  await act(async () => {
    await vi.dynamicImportSettled()
  })
}
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent === label,
  )!
  await act(async () => button.click())
}

it('passes the mentioned nodes, val and aggregated edges to the lazy library with cube-root sphere sizing', async () => {
  memories = [
    ...memories,
    { ...memories[0]!, subjectId: 'postgres', objectId: 'harbor', predicate: 'depends_on' },
  ]
  await render()
  expect(mock.constructor).toHaveBeenCalledWith(
    container.querySelector('[aria-label="Memory relationships"]'),
    { controlType: 'orbit', rendererConfig: { alpha: true } },
  )
  expect(data().nodes.map(({ id, val }) => ({ id, val }))).toEqual([
    { id: 'harbor', val: 6 },
    { id: 'postgres', val: 4 },
    { id: 'rina', val: 3 },
  ])
  expect(graph.nodeVal).toHaveBeenCalledWith('val')
  expect(graph.nodeRelSize).toHaveBeenCalledWith(4)
  expect(data().links[0]).toEqual({
    source: 'harbor',
    target: 'postgres',
    count: 2,
    predicates: ['depends_on', 'uses'],
  })
  const width = setting<(link: GraphLink) => number>('linkWidth')
  expect(width(data().links[0]!)).toBeGreaterThan(width(data().links[1]!))
  expect(graph.backgroundColor).toHaveBeenCalledWith('rgba(0,0,0,0)')
  expect(container.querySelector('[aria-label="Knowledge graph"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Entity kinds"]')?.textContent).toContain('person')
})

it('measures the container on resize and destroys the graph and observers on unmount', async () => {
  await render()
  expect(graph.width).toHaveBeenLastCalledWith(800)
  expect(graph.height).toHaveBeenLastCalledWith(400)
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
    width: 450,
    height: 900,
  } as DOMRect)
  resize()
  expect(graph.width).toHaveBeenLastCalledWith(450)
  expect(graph.height).toHaveBeenLastCalledWith(900)
  act(() => root.unmount())
  expect(disconnect).toHaveBeenCalledOnce()
  expect(graph._destructor).toHaveBeenCalledOnce()
  expect(mock.controls.removeEventListener).toHaveBeenCalledTimes(3)
  root = createRoot(container)
})

it('focuses clicked nodes and exposes keyboard buttons including Space', async () => {
  await render()
  setting<(node: GraphNode) => void>('onNodeClick')(data().nodes[0]!)
  expect(onFocus).toHaveBeenLastCalledWith('harbor')
  const button = container.querySelector('[aria-label="Focus Rina Okafor"]')!
  for (const key of ['Enter', ' '])
    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  expect(onFocus).toHaveBeenCalledTimes(3)
  expect(onFocus).toHaveBeenLastCalledWith('rina')
})

it('dims nonmatches, fits just search matches in 600ms, and fits everything when cleared', async () => {
  await render()
  await render({ matches: new Set(['harbor', 'postgres']) })
  expect(nodeColor('harbor')).toMatch(/,1\)$/)
  expect(nodeColor('rina')).toMatch(/,0\.16\)$/)
  const [ms, padding, filter] = graph.zoomToFit.mock.lastCall as [
    number,
    number,
    (node: GraphNode) => boolean,
  ]
  expect([ms, padding]).toEqual([600, 40])
  expect(
    data()
      .nodes.filter(filter)
      .map((node) => node.id),
  ).toEqual(['harbor', 'postgres'])
  expect(sprite('rina').material.opacity).toBe(0.16)
  await render()
  const all = graph.zoomToFit.mock.lastCall![2] as (node: GraphNode) => boolean
  expect(data().nodes.every(all)).toBe(true)
  expect(nodeColor('rina')).toMatch(/,1\)$/)
  await render({ matches: new Set() })
  const none = graph.zoomToFit.mock.lastCall![2] as (node: GraphNode) => boolean
  expect(data().nodes.some(none)).toBe(false)
})

it('flies to an external focus, but a new search takes camera precedence over the About chip', async () => {
  await render()
  await render({ focus: 'rina' })
  expect(graph.cameraPosition).toHaveBeenLastCalledWith(
    { x: 60, y: 10, z: 140 },
    { x: 60, y: 10, z: 20 },
    600,
  )
  await render({ focus: 'rina', matches: new Set(['harbor']) })
  const filter = graph.zoomToFit.mock.lastCall![2] as (node: GraphNode) => boolean
  expect(
    data()
      .nodes.filter(filter)
      .map((node) => node.id),
  ).toEqual(['harbor'])
})

it('highlights a hovered node, its neighbours and links, with predicate sprites at link midpoints', async () => {
  await render()
  hover('postgres')
  expect(nodeColor('rina')).toMatch(/,0\.16\)$/)
  expect(nodeColor('harbor')).toMatch(/,1\)$/)
  const makeSprite = setting<(link: GraphLink) => SpriteText>('linkThreeObject')
  expect(makeSprite(data().links[0]!).text).toBe('uses')
  expect(makeSprite(data().links[0]!).visible).toBe(true)
  expect(makeSprite(data().links[1]!).visible).toBe(false)
  const color = setting<(link: GraphLink) => string>('linkColor')
  expect(color(data().links[0]!)).toMatch(/,1\)$/)
  expect(color(data().links[1]!)).toMatch(/,0\.16\)$/)
  const label = makeSprite(data().links[0]!)
  setting<(object: object, coords: object) => void>('linkPositionUpdate')(label, {
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 20, z: 30 },
  })
  expect(label.position.set).toHaveBeenCalledWith(5, 10, 15)
  hover(null)
  expect(nodeColor('rina')).toMatch(/,1\)$/)
})

it('always labels the top twenty nodes and labels smaller nodes only on hover', async () => {
  entities = Array.from({ length: 24 }, (_, index) => ({
    id: `harbor-${index}`,
    label: `Harbor billing ${index}`,
    kind: 'project',
    aliases: [],
  }))
  memories = entities.map((entity) => ({ ...memories[0]!, subjectId: entity.id, objectId: null }))
  await render()
  expect(entities.filter((entity) => sprite(entity.id).visible)).toHaveLength(20)
  const small = entities.find((entity) => !sprite(entity.id).visible)!
  hover(small.id)
  expect(sprite(small.id).visible).toBe(true)
  hover(null)
  expect(sprite(small.id).visible).toBe(false)
})

it('uses theme tokens and re-reads them when the html dark class changes', async () => {
  await render()
  const original = nodeColor('rina')
  document.documentElement.style.setProperty('--px-accent', '#eca03d')
  await act(async () => {
    document.documentElement.classList.add('dark')
  })
  expect(nodeColor('rina')).not.toBe(original)
  expect(nodeColor('rina')).toBe('rgba(236,160,61,1)')
})

it('precomputes a reduced-motion layout and uses zero-duration focus, fit and zoom', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  await render({ focus: 'harbor' })
  expect(graph.warmupTicks).toHaveBeenCalledWith(300)
  expect(graph.cooldownTicks).toHaveBeenCalledWith(0)
  setting<() => void>('onEngineStop')()
  expect(graph.cameraPosition.mock.lastCall![2]).toBe(0)
  await click('Fit')
  expect(graph.zoomToFit).toHaveBeenLastCalledWith(0, 40)
  await click('Zoom in')
  expect(graph.cameraPosition.mock.lastCall![2]).toBe(0)
})

it('stops idle frames after cooling and camera motion, and wakes for input, drag and data updates', async () => {
  await render()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  setting<() => void>('onEngineStop')()
  vi.advanceTimersByTime(10000)
  expect(graph.pauseAnimation).toHaveBeenCalled()
  graph.resumeAnimation.mockClear()
  container
    .querySelector('[aria-label="Memory relationships"]')!
    .dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
  expect(graph.resumeAnimation).toHaveBeenCalled()
  setting<() => void>('onNodeDrag')()
  graph.pauseAnimation.mockClear()
  vi.advanceTimersByTime(1000)
  expect(graph.pauseAnimation).not.toHaveBeenCalled()
  setting<() => void>('onNodeDragEnd')()
  setting<() => void>('onEngineStop')()
  vi.advanceTimersByTime(1000)
  expect(graph.pauseAnimation).toHaveBeenCalled()
  vi.useRealTimers()
  graph.resumeAnimation.mockClear()
  memories = [...memories]
  await render()
  expect(graph.resumeAnimation).toHaveBeenCalled()
})

it('keeps zoom and Fit controls wired to the library', async () => {
  await render()
  await click('Zoom in')
  expect(graph.cameraPosition).toHaveBeenLastCalledWith(
    { x: 0, y: 0, z: 250 },
    mock.controls.target,
    600,
  )
  await click('Zoom out')
  expect(graph.cameraPosition.mock.lastCall![0].z).toBeCloseTo(360)
  await click('Fit')
  expect(graph.zoomToFit).toHaveBeenLastCalledWith(600, 40)
})

it('offers a calm fallback without loading the library when WebGL is unavailable', async () => {
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
  await render()
  expect(mock.constructor).not.toHaveBeenCalled()
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'You can still search and browse your memories.',
  )
  await click('Focus Harbor')
  expect(onFocus).toHaveBeenCalledWith('harbor')
})

it('catches initialization failures without crashing the rest of Brain', async () => {
  mock.constructor.mockImplementationOnce(function () {
    throw new Error('WebGL context refused')
  })
  await render()
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    '3D graph is unavailable',
  )
  expect(container.querySelector('[aria-label="Focus Rina Okafor"]')).not.toBeNull()
})

it('recovers when the library refuses the initial graph data', async () => {
  graph.graphData.mockImplementationOnce(() => {
    throw new Error('Scene data refused')
  })
  await render()
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    '3D graph is unavailable',
  )
  expect(graph._destructor).toHaveBeenCalledOnce()
  act(() => root.unmount())
  expect(graph._destructor).toHaveBeenCalledOnce()
  root = createRoot(container)
})

it('does not create a graph if unmounted while the lazy import is pending', async () => {
  await act(async () => {
    root.render(
      <BrainGraph3D entities={entities} memories={memories} focus={null} onFocus={onFocus} />,
    )
  })
  act(() => root.unmount())
  const calls = mock.constructor.mock.calls.length
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  expect(mock.constructor).toHaveBeenCalledTimes(calls)
  root = createRoot(container)
})
