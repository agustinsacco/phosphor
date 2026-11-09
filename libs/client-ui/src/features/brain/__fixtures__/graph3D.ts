import { vi } from 'vitest'

export function createGraphMock() {
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
}

export function installGraphEnvironment(): {
  resize: () => void
  disconnect: ReturnType<typeof vi.fn>
} {
  let resize: () => void
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    getExtension: () => null,
  } as unknown as WebGL2RenderingContext)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 400,
  } as DOMRect)
  const disconnect = vi.fn()
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
  return { resize: () => resize(), disconnect }
}
