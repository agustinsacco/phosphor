// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PerspectiveCamera } from 'three'
import type SpriteText from 'three-spritetext'
import type { BrainEntity, BrainMemory, BrainGraph, BrainLink } from '@shared/brain'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { MockExplorer } from './mockExplorer'
import type { GraphLink, GraphModel, GraphNode } from './graphModel'
import { BrainGraph3D } from './BrainGraph3D'
import { ExplorerGraph } from './explorer/ExplorerGraph'
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
  graph.scene.mockReturnValue(mock.scene)
  const camera = new PerspectiveCamera(40, 2, 0.1, 10000)
  camera.position.set(0, 0, 300)
  camera.updateMatrixWorld()
  graph.camera.mockReturnValue(camera)
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
  props: {
    focus?: string | null
    matches?: Set<string> | null
    path?: BrainLink[] | null
    scope?: 'all' | 'near'
  } = {},
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
        scope={props.scope}
        focus={props.focus ?? null}
        matches={props.matches ?? null}
        path={props.path ?? null}
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
    sentences: ['Harbor uses PostgreSQL'],
  })
  const width = setting<(link: GraphLink) => number>('linkWidth')
  expect(width(data().links[0]!)).toBeGreaterThan(0)
  expect(data().links[2]!.source).toBe('postgres')
  expect(graph.linkDirectionalArrowLength).toHaveBeenCalledWith(4)
  expect(graph.backgroundColor).toHaveBeenCalledWith('rgba(0,0,0,0)')
  expect(container.querySelector('[aria-label="Knowledge graph"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Entity kinds"]')?.textContent).toContain('People')
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

it('highlights a memory without moving a whole-graph camera, and fits everything when cleared', async () => {
  await render()
  setting<() => void>('onEngineStop')()
  graph.cameraPosition.mockClear()
  await render({ matches: new Set(['harbor', 'postgres']) })
  expect(nodeColor('harbor')).toMatch(/,1\)$/)
  expect(nodeColor('rina')).toMatch(/,0\.16\)$/)
  expect(sprite('rina').material.opacity).toBe(0.16)
  expect(graph.cameraPosition).not.toHaveBeenCalled()
  await render()
  expect(lastCamera().slice(1)).toEqual([centerOf(), 600])
})

it('never moves for an in-view selection, but fits the whole graph for an offscreen selection', async () => {
  await render()
  setting<() => void>('onEngineStop')()
  graph.cameraPosition.mockClear()
  await render({ focus: 'rina' })
  expect(graph.cameraPosition).not.toHaveBeenCalled()
  data().nodes.find((n) => n.id === 'harbor')!.x = 2000
  await render({ focus: 'harbor' })
  expect(lastCamera().slice(1)).toEqual([centerOf(), 600])
})

it('highlights a hovered node, its neighbours and links, with predicate sprites at link midpoints', async () => {
  await render()
  enterCanvas()
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
  enterCanvas()
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
  await click('Fit the graph')
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
  await click('Fit the graph')
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

it('keeps the whole graph framed on resize even with a selection', async () => {
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
  expect(lastCamera().slice(1)).toEqual([centerOf(), 0])
  await render({ focus: 'rina', matches: new Set(['harbor']) })
  shrink()
  expect(lastCamera().slice(1)).toEqual([centerOf(), 0])
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

it('highlights only the selected supported route and switches between two and three dimensions', async () => {
  await render()
  const route = projection.links.slice(0, 1)
  await render({ path: route })
  const color = setting<(link: GraphLink) => string>('linkColor')
  expect(color(data().links[0]!)).toMatch(/,1\)$/)
  expect(color(data().links[1]!)).toMatch(/,0\.16\)$/)
  expect(nodeColor('rina')).toMatch(/,0\.16\)$/)
  const label = setting<(link: GraphLink) => SpriteText>('linkThreeObject')
  expect(label(data().links[0]!).visible).toBe(true)
  expect(label(data().links[1]!).visible).toBe(false)
  await click('2D')
  expect(graph.numDimensions).toHaveBeenLastCalledWith(2)
  await click('3D')
  expect(graph.numDimensions).toHaveBeenLastCalledWith(3)
})

const canvas = (): Element => container.querySelector('[aria-label="Memory relationships"]')!
function enterCanvas(): void {
  act(() => {
    canvas().dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    canvas().dispatchEvent(new MouseEvent('pointerenter'))
  })
}
function leaveCanvas(): void {
  act(() => {
    canvas().dispatchEvent(new MouseEvent('pointerout', { bubbles: true }))
    canvas().dispatchEvent(new MouseEvent('pointerleave'))
  })
}

it('reads only the hovered edge support, retries an error and clears on hover exit', async () => {
  const detail = new MockExplorer().memory('memory-0')
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error('Support unavailable'))
    .mockResolvedValue(detail)
  const fake = createFakePhosphor({ 'brain:memory': read })
  const restore = installFakePhosphor(fake)
  try {
    await render()
    expect(read).not.toHaveBeenCalled()
    enterCanvas()
    const hoverEdge = setting<(link: GraphLink | null) => void>('onLinkHover')
    await act(async () => hoverEdge(data().links[0]!))
    expect(read).toHaveBeenCalledWith(data().links[0]!.memoryId)
    expect(container.querySelector('[role="status"]')!.textContent).toContain(
      'Harbor uses PostgreSQL',
    )
    expect(container.textContent).toContain('Support unavailable')
    await click('Retry')
    expect(container.textContent).toContain('Ledger is built for Harbor.')
    await act(async () => hoverEdge(null))
    expect(container.querySelector('[role="status"]')).toBeNull()
  } finally {
    restore()
    fake.dispose()
  }
})

it('dims distant nodes after selection, labels direct links and clears through empty space', async () => {
  const onClear = vi.fn()
  const explorer = new MockExplorer()
  const graphData = explorer.graph(null)
  await act(async () =>
    root.render(
      <BrainGraph3D graph={graphData} focus="rina" onFocus={onFocus} onClear={onClear} />,
    ),
  )
  expect(nodeColor('rina')).toMatch(/,1\)$/)
  expect(nodeColor('mara')).toMatch(/,1\)$/)
  expect(nodeColor('harbor')).toMatch(/,0.16\)$/)
  const direct = data().links.find((l) => l.source === 'rina' && l.target === 'mara')!
  const label = setting<(link: GraphLink) => SpriteText>('linkThreeObject')(direct)
  expect(label.visible).toBe(true)
  expect(label.text).toContain('works with')
  setting<() => void>('onBackgroundClick')()
  expect(onClear).toHaveBeenCalledOnce()
  await act(async () =>
    root.render(
      <BrainGraph3D graph={graphData} focus={null} onFocus={onFocus} onClear={onClear} />,
    ),
  )
  expect(nodeColor('harbor')).toMatch(/,1\)$/)
  expect(label.visible).toBe(false)
  expect(lastCamera()[1]).toEqual(centerOf())
})

it('keeps every named entity bright even if the selected memory only links some of them', async () => {
  const explorer = new MockExplorer()
  const graphData = explorer.graph(null)
  const path = graphData.links.filter((l) => l.subjectId === 'rina' || l.objectId === 'rina')
  const matches = new Set(['rina', 'ledger', 'harbor'])
  await act(async () =>
    root.render(
      <BrainGraph3D
        graph={graphData}
        focus={null}
        path={path}
        matches={matches}
        onFocus={onFocus}
      />,
    ),
  )
  for (const id of matches) expect(nodeColor(id)).toMatch(/,1\)$/)
  expect(container.querySelectorAll('[aria-label="Graph entities"] li')).toHaveLength(
    graphData.nodes.length,
  )
})

it('does not zoom when a memory highlight gives way to an entity selection', async () => {
  await render({ focus: 'rina', matches: new Set(['harbor']) })
  setting<() => void>('onEngineStop')()
  graph.cameraPosition.mockClear()
  await render({ focus: 'rina' })
  expect(graph.cameraPosition).not.toHaveBeenCalled()
})

it('clearing a selection restores every node even while the pointer stayed on the graph', async () => {
  await render({ focus: 'rina' })
  enterCanvas()
  hover('rina')
  await render()
  expect(nodeColor('postgres')).toMatch(/,1\)$/)
})

it('places the focus badge inside the canvas frame, separate from toolbar and legend', async () => {
  await render()
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Focus Rina Okafor"]')!.focus())
  const badge = container.querySelector('[role="status"]')!
  const canvas = container.querySelector('[aria-label="Memory relationships"]')!
  expect(badge.parentElement).toBe(canvas.parentElement)
  expect(badge.parentElement!.querySelector('[aria-label="Entity kinds"]')).toBeNull()
})
it('clears link support when the pointer exits the canvas even without a vendor hover callback', async () => {
  const fake = createFakePhosphor({ 'brain:memory': () => new MockExplorer().memory('memory-0') })
  const restore = installFakePhosphor(fake)
  try {
    await render()
    enterCanvas()
    await act(async () => setting<(link: GraphLink) => void>('onLinkHover')(data().links[0]!))
    expect(container.textContent).toContain('Ledger is built for Harbor.')
    leaveCanvas()
    expect(container.textContent).not.toContain('Ledger is built for Harbor.')
  } finally {
    restore()
    fake.dispose()
  }
})

it('ignores link support the scene reports while the pointer is outside the graph', async () => {
  const read = vi.fn(() => new MockExplorer().memory('memory-0'))
  const fake = createFakePhosphor({ 'brain:memory': read })
  const restore = installFakePhosphor(fake)
  try {
    await render()
    // The library raycasts from its default pointer position before any pointer reaches the canvas.
    await act(async () => setting<(link: GraphLink) => void>('onLinkHover')(data().links[0]!))
    expect(read).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Ledger is built for Harbor.')
  } finally {
    restore()
    fake.dispose()
  }
})

it('ignores a hovered node the scene reports with no pointer on the graph and drops it on leave', async () => {
  await render()
  // The library keeps raycasting from its last, or default, pointer position.
  hover('postgres')
  expect(nodeColor('rina')).toMatch(/,1\)$/)
  enterCanvas()
  hover('postgres')
  expect(nodeColor('rina')).toMatch(/,0\.16\)$/)
  leaveCanvas()
  expect(nodeColor('rina')).toMatch(/,1\)$/)
})

it('keeps a selection bright while the pointer hovers another node', async () => {
  await render({ focus: 'rina' })
  enterCanvas()
  hover('postgres')
  // Rina owns Harbor; PostgreSQL is outside the selection and is lit only because it is hovered.
  expect(nodeColor('rina')).toMatch(/,1\)$/)
  expect(nodeColor('harbor')).toMatch(/,1\)$/)
  expect(nodeColor('postgres')).toMatch(/,1\)$/)
  const color = setting<(link: GraphLink) => string>('linkColor')
  expect(color(data().links.find((l) => l.memoryId === 'db')!)).toMatch(/,0\.16\)$/)
  hover(null)
  expect(nodeColor('postgres')).toMatch(/,0\.16\)$/)
})

it('does not move for a visible node near the viewport edge', async () => {
  await render()
  setting<() => void>('onEngineStop')()
  data().nodes.find((n) => n.id === 'rina')!.x =
    0.95 * (300 - 20) * Math.tan((20 * Math.PI) / 180) * 2
  graph.cameraPosition.mockClear()
  await render({ focus: 'rina' })
  expect(graph.cameraPosition).not.toHaveBeenCalled()
})
it('fits the neighbourhood on scope changes and all shown nodes on explicit Fit', async () => {
  await render({ focus: 'rina' })
  setting<() => void>('onEngineStop')()
  graph.cameraPosition.mockClear()
  await render({ focus: 'rina', scope: 'near' })
  expect(lastCamera().slice(1)).toEqual([centerOf(), 600])
  graph.cameraPosition.mockClear()
  await click('Fit the graph')
  expect(lastCamera().slice(1)).toEqual([centerOf(), 600])
})
it('fits all nodes after a selection is newly added to the layout', async () => {
  await render()
  setting<() => void>('onEngineStop')()
  entities = [...entities, { ...entities[0]!, id: 'kestrel', label: 'Kestrel' }]
  graph.cameraPosition.mockClear()
  await render({ focus: 'kestrel' })
  setting<() => void>('onEngineStop')()
  expect(lastCamera().slice(1)).toEqual([centerOf(), 600])
})

it('does not clear the camera while the real explorer loads an in-view memory selection', async () => {
  const explorer = new MockExplorer()
  const graphData = explorer.graph('rina')
  const detail = explorer.details.find((d) =>
    d.memory.entityIds.every((id) => graphData.nodes.some((n) => n.id === id)),
  )!
  let resolve!: (value: typeof detail) => void
  const fake = createFakePhosphor({
    'brain:overview': () => graphData,
    'brain:memory': () =>
      new Promise((done) => {
        resolve = done
      }),
  })
  const restore = installFakePhosphor(fake)
  try {
    await act(async () =>
      root.render(<ExplorerGraph entityId="rina" path={null} onVisit={() => {}} />),
    )
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    setting<() => void>('onEngineStop')()
    graph.cameraPosition.mockClear()
    await act(async () =>
      root.render(
        <ExplorerGraph
          entityId={null}
          memoryId={detail.memory.id}
          path={null}
          onVisit={() => {}}
        />,
      ),
    )
    expect(graph.cameraPosition).not.toHaveBeenCalled()
    await act(async () => resolve(detail))
    expect(graph.cameraPosition).not.toHaveBeenCalled()
  } finally {
    restore()
    fake.dispose()
  }
})
