// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type SpriteText from 'three-spritetext'
import type { BrainEntity, BrainMemory, BrainGraph } from '@shared/brain'
import type { GraphLink, GraphModel, GraphNode } from './graphModel'
import { BrainGraph3D } from './BrainGraph3D'
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
    material = { opacity: 1 }
    position = { y: 0, set: vi.fn() }
    constructor(public text: string) {}
  },
}))

let root: Root
let container: HTMLDivElement
let entities: BrainEntity[]
let memories: BrainMemory[]
let projection: BrainGraph
let previousEntities: BrainEntity[]
let previousMemories: BrainMemory[]
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
/** The camera fits the nodes it is given: it looks at the middle of their extent. */
const centerOf = (ids?: string[]) => {
  const nodes = data().nodes.filter((node) => !ids || ids.includes(node.id))
  const mid = (axis: 'x' | 'y' | 'z') =>
    (Math.min(...nodes.map((n) => n[axis]!)) + Math.max(...nodes.map((n) => n[axis]!))) / 2
  return { x: mid('x'), y: mid('y'), z: mid('z') }
}
const lastCamera = () => graph.cameraPosition.mock.lastCall as [unknown, unknown, number]
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
  graph.camera.mockReturnValue({
    fov: 40,
    aspect: 2,
    // Looking down -z with +y up, as the library's default camera does.
    matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 300, 1] },
    updateMatrixWorld: vi.fn(),
  })
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
  const sample = graphFixture()
  entities = sample.entities
  memories = sample.memories
  const environment = installGraphEnvironment()
  resize = environment.resize
  disconnect = environment.disconnect
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
  if (entities !== previousEntities || memories !== previousMemories) {
    projection = boundedGraph(entities, memories)
    previousEntities = entities
    previousMemories = memories
  }
  await act(async () =>
    root.render(
      <BrainGraph3D
        graph={projection}
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
    {
      ...memories[0]!,
      links: [
        {
          ...memories[0]!.links[0]!,
          id: 'reverse',
          subjectId: 'postgres',
          objectId: 'harbor',
          predicate: 'depends_on',
        },
      ],
    },
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
    id: 'link-db',
    memoryId: 'db',
    count: 1,
    predicates: ['uses'],
  })
  const width = setting<(link: GraphLink) => number>('linkWidth')
  expect(width(data().links[0]!)).toBeGreaterThan(0)
  expect(data().links[2]!.source).toBe('postgres')
  expect(graph.linkDirectionalArrowLength).toHaveBeenCalledWith(4)
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
  expect(lastCamera()[1]).toEqual(centerOf(['harbor', 'postgres']))
  expect(lastCamera()[2]).toBe(600)
  expect(centerOf(['harbor', 'postgres'])).not.toEqual(centerOf())
  expect(sprite('rina').material.opacity).toBe(0.16)
  await render()
  expect(lastCamera()[1]).toEqual(centerOf())
  expect(nodeColor('rina')).toMatch(/,1\)$/)
  graph.cameraPosition.mockClear()
  await render({ matches: new Set() })
  expect(graph.cameraPosition).not.toHaveBeenCalled()
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
  expect(lastCamera()[1]).toEqual(centerOf(['harbor']))
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
    description: '',
  }))
  memories = entities.map((entity) => ({ ...memories[0]!, entityIds: [entity.id], links: [] }))
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
  expect(lastCamera()[1]).toEqual(centerOf())
  expect(lastCamera()[2]).toBe(0)
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
  expect(lastCamera()[1]).toEqual(centerOf())
  expect(lastCamera()[2]).toBe(600)
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
      <BrainGraph3D graph={boundedGraph(entities, memories)} focus={null} onFocus={onFocus} />,
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

it('keeps the keyboard list hidden and names just the focused entity in a visible chip', async () => {
  await render()
  const list = container.querySelector('[aria-label="Graph entities"]')!
  expect(list.className).toBe('sr-only')
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Focus Rina Okafor"]')!
  act(() => button.focus())
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Focus Rina Okafor')
  act(() => button.blur())
  expect(container.querySelector('[role="status"]')).toBeNull()
})

it('fits after the first layout, then refits resized panes instantly with small padding', async () => {
  await render()
  expect(graph.cooldownTicks).toHaveBeenLastCalledWith(300)
  graph.cameraPosition.mockClear()
  setting<() => void>('onEngineStop')()
  expect(graph.cameraPosition).toHaveBeenCalledOnce()
  expect(lastCamera().slice(1)).toEqual([centerOf(), 600])
  graph.cameraPosition.mockClear()
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
    width: 450,
    height: 400,
  } as DOMRect)
  resize()
  expect(lastCamera().slice(1)).toEqual([centerOf(), 0])
  resize()
  expect(graph.cameraPosition).toHaveBeenCalledOnce()
})

it.each(['orbit', 'zoom'])('does not override %s on container resize', async (action) => {
  await render()
  setting<() => void>('onEngineStop')()
  if (action === 'orbit') {
    const start = mock.controls.addEventListener.mock.calls.find(
      ([name]) => name === 'start',
    )![1] as () => void
    start()
  } else await click('Zoom in')
  graph.cameraPosition.mockClear()
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
    width: 450,
    height: 400,
  } as DOMRect)
  resize()
  expect(graph.cameraPosition).not.toHaveBeenCalled()
})

it('keeps an About focus or a search framed, instantly, when the pane resizes', async () => {
  await render()
  setting<() => void>('onEngineStop')()
  const shrink = (): void => {
    graph.cameraPosition.mockClear()
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValueOnce({
      width: 450 + graph.width.mock.calls.length,
      height: 400,
    } as DOMRect)
    resize()
  }
  await render({ focus: 'rina' })
  shrink()
  expect(graph.cameraPosition).toHaveBeenCalledOnce()
  expect(lastCamera().slice(1)).toEqual([{ x: 60, y: 10, z: 20 }, 0])
  await render({ focus: 'rina', matches: new Set(['harbor']) })
  shrink()
  expect(lastCamera().slice(1)).toEqual([centerOf(['harbor']), 0])
})

it('refits with the measured pane shape, not the camera aspect the library has yet to update', async () => {
  await render()
  // Spread wide enough that the minimum camera distance doesn't decide the fit.
  data().nodes.forEach((node, index) => {
    node.x = index * 600
  })
  setting<() => void>('onEngineStop')()
  const resizeTo = (width: number): { z: number } => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValueOnce({
      width,
      height: 400,
    } as DOMRect)
    resize()
    return lastCamera()[0] as { z: number }
  }
  // The camera mock keeps aspect 2 throughout, as the library does until its next update.
  const narrow = resizeTo(300)
  const wide = resizeTo(1200)
  expect(wide.z).toBeLessThan(narrow.z)
})

it('keeps drawing after a resize until the library has applied the new canvas size', async () => {
  await render()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  setting<() => void>('onEngineStop')()
  vi.advanceTimersByTime(10000)
  graph.pauseAnimation.mockClear()
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValueOnce({
    width: 450,
    height: 400,
  } as DOMRect)
  resize()
  vi.advanceTimersByTime(300)
  expect(graph.pauseAnimation).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1000)
  expect(graph.pauseAnimation).toHaveBeenCalled()
  vi.useRealTimers()
})

it('does not consume the pending fit when resuming a previously stopped engine before new data', async () => {
  await render()
  setting<() => void>('onEngineStop')()
  graph.resumeAnimation.mockImplementation(() => {
    setting<() => void>('onEngineStop')()
    return graph
  })
  memories = [...memories]
  await render()
  graph.cameraPosition.mockClear()
  setting<() => void>('onEngineStop')()
  expect(graph.cameraPosition).toHaveBeenCalledOnce()
})
