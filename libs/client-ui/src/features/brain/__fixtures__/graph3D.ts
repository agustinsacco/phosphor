import { vi } from 'vitest'

export function createGraphMock() {
  const names = [
    'numDimensions',
    'linkDirectionalArrowLength',
    'linkDirectionalArrowRelPos',
    'onLinkHover',
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
    'cameraPosition',
    'camera',
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

import type { BrainEntity, BrainGraph, BrainMemory } from '@shared/brain'
import { mockBrainData } from '../mockBrainData'
export function graphFixture(): { entities: BrainEntity[]; memories: BrainMemory[] } {
  const entity = (id: string, label: string, kind: BrainEntity['kind']): BrainEntity => ({
    id,
    label,
    kind,
    aliases: [],
    description: '',
  })
  const base = mockBrainData().details[0]!.memory
  const memory = (
    id: string,
    subjectId: string,
    objectId: string,
    predicate: 'uses' | 'owns',
  ): BrainMemory => ({
    ...base,
    id,
    entityIds: [subjectId, objectId],
    links: [{ id: `link-${id}`, memoryId: id, subjectId, objectId, predicate }],
  })
  return {
    entities: [
      entity('harbor', 'Harbor', 'project'),
      entity('postgres', 'PostgreSQL', 'component'),
      entity('rina', 'Rina Okafor', 'person'),
    ],
    memories: [
      memory('db', 'harbor', 'postgres', 'uses'),
      memory('owner', 'rina', 'harbor', 'owns'),
    ],
  }
}
export function boundedGraph(entities: BrainEntity[], memories: BrainMemory[]): BrainGraph {
  return {
    centerId: null,
    truncated: false,
    nodes: entities.map((e) => ({
      ...e,
      memories: memories.filter((m) => m.entityIds.includes(e.id)).length,
      connections: new Set(
        memories
          .flatMap((m) => m.links)
          .flatMap((l) =>
            l.subjectId === e.id ? [l.objectId] : l.objectId === e.id ? [l.subjectId] : [],
          ),
      ).size,
    })),
    links: memories.flatMap((m) => m.links),
  }
}
