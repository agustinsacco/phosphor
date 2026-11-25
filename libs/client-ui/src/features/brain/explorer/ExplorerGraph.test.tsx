// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainGraph, BrainLink } from '@shared/brain'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { ExplorerGraph } from './ExplorerGraph'
import { MockExplorer } from '../mockExplorer'
import { mockRoutes } from '../mockRecall'
import { graphLink } from '../__fixtures__/graph3D'
const mounts = vi.hoisted(() => vi.fn())
const projected = vi.hoisted(() => vi.fn())
vi.mock('../BrainGraph3D', () => ({
  BrainGraph3D: ({
    graph,
    path,
    toolbar,
    matches,
  }: {
    graph: BrainGraph
    path: BrainLink[] | null
    toolbar?: React.ReactNode
    matches?: Set<string> | null
  }) => {
    projected(graph)
    useEffect(() => {
      mounts()
    }, [])
    return (
      <div
        data-path={path?.map((link) => link.id).join(',')}
        data-matches={matches ? [...matches].join(',') : undefined}
      >
        {toolbar}
        {graph.centerId ?? 'overview scene'}
        <span>{graph.nodes.map((node) => node.id).join(',')}</span>
      </div>
    )
  },
}))
afterEach(() => {
  vi.unstubAllGlobals()
  mounts.mockReset()
})
it('keeps the scene mounted while a new neighbourhood read is pending', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const explorer = new MockExplorer()
  let done!: (value: BrainGraph) => void
  const fake = createFakePhosphor({
    'brain:overview': () => explorer.graph('rina'),
    'brain:neighbourhood': () =>
      new Promise((resolve) => {
        done = resolve
      }),
  })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  const onVisit = vi.fn()
  try {
    await act(async () =>
      root.render(<ExplorerGraph entityId={null} path={null} onVisit={onVisit} />),
    )
    await act(async () =>
      root.render(<ExplorerGraph entityId="harbor" path={null} onVisit={onVisit} />),
    )
    expect(container.textContent).toContain('rina')
    await act(async () => done(explorer.graph('harbor')))
    expect(container.textContent).toContain('harbor')
    expect(mounts).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})

it('includes missing route nodes beyond the neighbourhood and passes the route to the scene', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const explorer = new MockExplorer()
  const route = mockRoutes(explorer, 'rina', 'harbor').routes[0]!.flatMap((step) =>
    step.kind === 'relation' ? [step.link] : [],
  )
  const read = vi.fn((id: string) => explorer.entity(id))
  const fake = createFakePhosphor({
    'brain:overview': () => explorer.graph('rina'),
    'brain:neighbourhood': (id, hops) => explorer.graph(id, hops),
    'brain:entity': read,
  })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<ExplorerGraph entityId="rina" path={route} onVisit={vi.fn()} />),
    )
    expect(read).toHaveBeenCalledWith('harbor')
    expect(container.textContent).toContain('harbor')
    expect(container.querySelector('[data-path]')!.getAttribute('data-path')).toBe(
      route.map((link) => link.id).join(','),
    )
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})

it('keeps every overview node drawn after selecting an entity', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const explorer = new MockExplorer()
  const overview = explorer.graph(null)
  const fake = createFakePhosphor({
    'brain:overview': () => overview,
    'brain:neighbourhood': (id, hops) => explorer.graph(id, hops),
  })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<ExplorerGraph entityId={null} path={null} onVisit={vi.fn()} />),
    )
    await act(async () =>
      root.render(<ExplorerGraph entityId="rina" path={null} onVisit={vi.fn()} />),
    )
    for (const node of overview.nodes) expect(container.textContent).toContain(node.id)
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})

it('makes neighbours-only opt-in, supports two steps, and resets scope on clear', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const explorer = new MockExplorer()
  const near = vi.fn((id: string, hops: 1 | 2) => explorer.graph(id, hops))
  const fake = createFakePhosphor({
    'brain:overview': () => explorer.graph(null),
    'brain:neighbourhood': near,
  })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  const render = (entityId: string | null) =>
    act(async () =>
      root.render(<ExplorerGraph entityId={entityId} path={null} onVisit={vi.fn()} />),
    )
  const click = (text: string) =>
    act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === text)!.click(),
    )
  try {
    await render('rina')
    expect(near).not.toHaveBeenCalled()
    await click('Neighbours only')
    expect(near).toHaveBeenCalledWith('rina', 1)
    expect(container.textContent).not.toContain('northwind')
    await click('2 steps')
    expect(near).toHaveBeenCalledWith('rina', 2)
    expect(container.textContent).toContain('northwind')
    await click('Whole graph')
    expect(container.textContent).toContain('harbor')
    await click('Neighbours only')
    await render(null)
    await render('rina')
    expect(
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Whole graph')
        ?.getAttribute('aria-pressed'),
    ).toBe('true')
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})

it('highlights all named things and supported links when opening a memory, not just its first entity', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const explorer = new MockExplorer()
  const detail = explorer.details.find((d) => d.memory.links.length > 0)!
  detail.memory.entityIds.push('rina')
  const fake = createFakePhosphor({
    'brain:overview': () => explorer.graph(null),
    'brain:memory': () => detail,
    'brain:entity': (id) => explorer.entity(id),
  })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <ExplorerGraph entityId={null} memoryId={detail.memory.id} path={null} onVisit={vi.fn()} />,
      ),
    )
    expect(container.querySelector('[data-path]')!.getAttribute('data-path')).toBe(
      detail.memory.links.map((l) => l.id).join(','),
    )
    expect(container.querySelector('[data-matches]')!.getAttribute('data-matches')).toBe(
      [...new Set(detail.memory.entityIds)].join(','),
    )
    for (const node of explorer.graph(null).nodes) expect(container.textContent).toContain(node.id)
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})

it('retries an overview failure and an outside selection failure without unmounting the scene', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const explorer = new MockExplorer()
  const overview = vi
    .fn()
    .mockRejectedValueOnce(new Error('Overview failed'))
    .mockResolvedValue(explorer.graph('rina'))
  const near = vi
    .fn()
    .mockRejectedValueOnce(new Error('Neighbourhood failed'))
    .mockResolvedValue(explorer.graph('harbor'))
  const fake = createFakePhosphor({ 'brain:overview': overview, 'brain:neighbourhood': near })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  const retry = () =>
    act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click(),
    )
  try {
    await act(async () =>
      root.render(<ExplorerGraph entityId="harbor" path={null} onVisit={vi.fn()} />),
    )
    expect(container.textContent).toContain('Overview failed')
    await retry()
    expect(container.textContent).toContain('Neighbourhood failed')
    expect(container.textContent).toContain('rina')
    await retry()
    expect(container.textContent).toContain('harbor')
    expect(container.textContent).not.toContain('failed')
    expect(mounts).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})

it('prioritizes the outside selection, route and direct neighbours through the real projection caller', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const explorer = new MockExplorer()
  const node = (id: string) => ({ ...explorer.graph(null).nodes[0]!, id, label: id })
  const overview: BrainGraph = {
    nodes: Array.from({ length: 300 }, (_, i) => node(`Harbor-${i}`)),
    links: [],
    ended: [],
    centerId: null,
    truncated: true,
  }
  const near: BrainGraph = {
    nodes: [node('Ledger'), node('Kestrel')],
    links: [
      graphLink({
        id: 'near',
        subjectId: 'Ledger',
        objectId: 'Kestrel',
        predicate: 'uses',
        memoryId: 'm',
      }),
    ],
    ended: [],
    centerId: 'Ledger',
    truncated: false,
  }
  const path: BrainLink[] = [
    graphLink({
      id: 'route',
      subjectId: 'Ledger',
      objectId: 'Rina',
      predicate: 'uses',
      memoryId: 'm',
    }),
  ]
  const fake = createFakePhosphor({
    'brain:overview': () => overview,
    'brain:neighbourhood': () => near,
    'brain:entity': (id) => ({ ...explorer.entity('rina'), entity: node(id) }),
  })
  const restore = installFakePhosphor(fake)
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () =>
      root.render(<ExplorerGraph entityId="Ledger" path={path} onVisit={vi.fn()} />),
    )
    const graph: BrainGraph = projected.mock.lastCall![0]
    expect(graph.nodes).toHaveLength(300)
    expect(graph.nodes.slice(0, 3).map((n) => n.id)).toEqual(['Ledger', 'Rina', 'Kestrel'])
    expect(graph.links.map((l) => l.id)).toEqual(expect.arrayContaining(['near', 'route']))
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})
