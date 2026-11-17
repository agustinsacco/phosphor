// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { BrainKnowledge } from './BrainKnowledge'
import { useExplorer, type ExplorerState } from './useExplorer'
import { MockExplorer } from '../mockExplorer'
import { useBrain } from '../useBrain'
import { mockBrainJob, mockBrainStatus } from '../mockBrainData'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'

let root: Root, container: HTMLDivElement, state: ExplorerState, explorer: MockExplorer
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
const browse = vi.fn<MockExplorer['browse']>()
const recent = vi.fn<MockExplorer['recent']>()
const entity = vi.fn<MockExplorer['entity']>()
const memory = vi.fn<MockExplorer['memory']>()
const connections = vi.fn<MockExplorer['connections']>()
const memories = vi.fn<MockExplorer['memories']>()
const onOpenRead = vi.fn()
function Harness(): React.JSX.Element {
  state = useExplorer()
  return <BrainKnowledge state={state} onOpenRead={onOpenRead} />
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  explorer = new MockExplorer()
  explorer.details[0]!.memory.jobId = 'harbor-read'
  browse.mockReset().mockImplementation((...args) => explorer.browse(...args))
  recent
    .mockReset()
    .mockImplementation((...args) =>
      explorer.recent(args[0], [mockBrainJob({ id: 'harbor-read', state: 'done' })]),
    )
  entity.mockReset().mockImplementation((id) => explorer.entity(id))
  memory.mockReset().mockImplementation((id) => explorer.memory(id))
  connections.mockReset().mockImplementation((...args) => explorer.connections(...args))
  memories.mockReset().mockImplementation((...args) => explorer.memories(...args))
  onOpenRead.mockReset()
  fake = createFakePhosphor({
    'brain:entities': browse,
    'brain:recent': recent,
    'brain:entity': entity,
    'brain:memory': memory,
    'brain:overview': () => explorer.graph(null),
    'brain:neighbourhood': (id, hops) => explorer.graph(id, hops),
    'brain:entityMemories': memories,
    'brain:connections': connections,
    'brain:find': (q, n) => explorer.find(q, n),
    'brain:path': (a, b) => explorer.path(a, b),
    'brain:forget': () => ({ ...mockBrainStatus(), revision: 1 }),
  })
  restore = installFakePhosphor(fake)
  useBrain.setState({ status: mockBrainStatus(), error: '', saving: false })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const render = () => act(async () => root.render(<Harness />))
const section = (name: string): HTMLElement => container.querySelector(`[aria-label="${name}"]`)!
function button(label: string, inside: HTMLElement = container): HTMLButtonElement {
  return [...inside.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label,
  )!
}
const click = (label: string, inside?: HTMLElement) =>
  act(async () => button(label, inside).click())
const visit = (kind: 'entity' | 'memory', id: string, label = id) =>
  act(async () => state.onVisit({ kind, id, label }))
const key = (key: string, options: KeyboardEventInit = {}, target: HTMLElement = container) =>
  act(async () =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options })),
  )

it('shows the browse list, only present kinds, twenty-at-a-time paging and recent memories', async () => {
  await render()
  expect(section('Most connected').querySelectorAll('.brain-row')).toHaveLength(20)
  expect(section('Recently learned').textContent).toContain('Harbor planning')
  expect(button('People')).toBeDefined()
  expect(button('Events')).toBeUndefined()
  await click('Show more', section('Most connected'))
  expect(browse).toHaveBeenLastCalledWith(null, 20, 20, 'connected')
  expect(section('Most connected').querySelectorAll('.brain-row').length).toBeGreaterThan(20)
  await click('People')
  expect(browse).toHaveBeenLastCalledWith('person', 0, 20, 'connected')
  expect(section('Most connected').querySelectorAll('.brain-row')).toHaveLength(2)
  expect(section('Recently learned')).toBeNull()
  await click('All')
  expect(section('Recently learned')).not.toBeNull()
  await act(async () =>
    section('Most connected').querySelector<HTMLButtonElement>('.brain-row')!.click(),
  )
  expect(section('Entity detail')).not.toBeNull()
})

it.each(['browse', 'recent'] as const)('recovers when the first %s load fails', async (which) => {
  if (which === 'browse') browse.mockRejectedValueOnce(new Error('Browse failed'))
  else recent.mockRejectedValueOnce(new Error('Recent failed'))
  await render()
  const name = which === 'browse' ? 'Most connected' : 'Recently learned'
  expect(section(name).textContent).toContain('failed')
  await click('Retry', section(name))
  expect(section(name).textContent).not.toContain('failed')
  expect(section(name).querySelectorAll('.brain-row').length).toBeGreaterThan(0)
})

it('shows entity connections, type counts and memory rows, keeping state and lane filters', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  expect(section('Entity detail').textContent).toContain('organization')
  expect(section('Connections').textContent).toContain('Contains')
  expect(button('Decisions 1', section('Entity memories'))).toBeDefined()
  expect(section('Entity memories').querySelector('[aria-label="Source lane"]')).not.toBeNull()
  expect(section('Entity memories').querySelector('[aria-label="Memory state"]')).not.toBeNull()
  await click('Decisions 1', section('Entity memories'))
  expect(memories.mock.lastCall?.[1].types).toEqual(['decision'])
  expect(section('Entity memories').querySelectorAll('.brain-row')).toHaveLength(1)
  await act(async () =>
    section('Entity memories').querySelector<HTMLButtonElement>('.brain-row')!.click(),
  )
  expect(section('Memory detail').textContent).toContain('learned')
  expect(section('Evidence').querySelector('mark')?.textContent).toBe(
    'Harbor Ledger is built for Harbor.',
  )
  expect(section('Links').textContent).toContain('for customer')
  await click('See the read that produced this')
  expect(onOpenRead).toHaveBeenCalledWith('harbor-read')
})

it('pages entity connections and memories, and retries failures in each', async () => {
  await render()
  await visit('entity', 'harbor')
  connections.mockRejectedValueOnce(new Error('Connections failed'))
  await click('Show more', section('Connections'))
  expect(section('Connections').textContent).toContain('Connections failed')
  await click('Retry', section('Connections'))
  expect(section('Connections').textContent).not.toContain('Connections failed')
  memories.mockRejectedValueOnce(new Error('Memories failed'))
  await click('Show more memories')
  expect(section('Entity memories').textContent).toContain('Memories failed')
  await click('Retry', section('Entity memories'))
  expect(section('Entity memories').querySelectorAll('.brain-row').length).toBeGreaterThan(20)
})

it('recovers the entity detail and memory detail after an initial failure', async () => {
  await render()
  entity.mockRejectedValueOnce(new Error('Entity failed'))
  await visit('entity', 'harbor')
  expect(section('Brain Explorer').textContent).toContain('Entity failed')
  await click('Retry', section('Brain Explorer'))
  expect(section('Entity detail')).not.toBeNull()
  memory.mockRejectedValueOnce(new Error('Memory failed'))
  await visit('memory', 'memory-0')
  expect(section('Brain Explorer').textContent).toContain('Memory failed')
  await click('Retry', section('Brain Explorer'))
  expect(section('Memory detail')).not.toBeNull()
})

it('keeps a compact breadcrumb and the Forward trail after clearing with Escape or the chip', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  await visit('entity', 'ledger', 'Ledger')
  await visit('entity', 'rina', 'Rina Okafor')
  await visit('entity', 'tom', 'Tom Lee')
  expect(section('Brain trail').textContent).toContain('…')
  expect(section('Brain trail').textContent).not.toContain('Harbor')
  expect(section('Brain trail').textContent).toContain('Ledger')
  await click('Back', section('Brain trail'))
  expect(state.visit?.id).toBe('rina')
  await key('ArrowRight', { altKey: true })
  expect(state.visit?.id).toBe('tom')
  await key('Backspace')
  expect(state.visit?.id).toBe('rina')
  await key('Escape')
  expect(state.visit).toBeUndefined()
  expect(section('Most connected')).not.toBeNull()
  await click('Forward', section('Brain trail'))
  expect(state.visit?.id).toBe('harbor')
  await click('Clear selection')
  expect(state.visit).toBeUndefined()
  await key('ArrowRight', { altKey: true })
  expect(state.visit?.id).toBe('harbor')
  await click('Overview', section('Brain trail'))
  expect(state.visit).toBeUndefined()
})

it('does not steal Escape from inputs, selects, menus or dialogs', async () => {
  await render()
  await visit('entity', 'harbor')
  for (const tag of ['input', 'select', 'div']) {
    const target = document.createElement(tag)
    if (tag === 'div') target.setAttribute('role', 'dialog')
    container.append(target)
    await key('Escape', {}, target)
    expect(state.visit?.id).toBe('harbor')
    target.remove()
  }
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  container.append(menu)
  await key('Escape', {}, menu)
  expect(state.visit?.id).toBe('harbor')
  menu.remove()
})

it('keeps the graph beside an empty Brain and never offers a hide graph button', async () => {
  explorer.entities = []
  explorer.details = []
  await render()
  expect(section('Brain Explorer').textContent).toContain('Queue for knowledge extraction')
  expect(section('Knowledge graph')).not.toBeNull()
  expect(button('Hide graph')).toBeUndefined()
})

it('uses singular memory counts in browse and entity detail', async () => {
  const row = explorer.browse(null, 0, 100, 'connected').items.find((item) => item.memories === 1)!
  await render()
  expect(section('Most connected').textContent).not.toContain('1 memories')
  await visit('entity', row.entity.id)
  expect(section('Entity detail').textContent).toContain('1 memory')
  expect(section('Entity detail').textContent).not.toContain('1 memories')
})
it('keeps each stored quote label unchanged without attributing it to the origin lane', async () => {
  const detail = explorer.details[0]!
  detail.quotes = [
    'user · 2026-11-01T00:00:00Z · Harbor',
    'assistant · 2026-11-02T00:00:00Z · Ledger',
  ].map((label) => ({ quote: 'Kestrel uses Ledger.', before: '', after: '', label }))
  detail.sourcePath = '/demo/Harbor/origin.jsonl'
  await render()
  await visit('memory', detail.memory.id)
  const captions = [...section('Evidence').querySelectorAll('figcaption')].map((c) => c.textContent)
  expect(captions).toEqual(detail.quotes.map((q) => q.label))
  expect(section('Memory detail').querySelectorAll('button')).toSatisfy(
    (buttons: NodeListOf<HTMLButtonElement>) =>
      [...buttons].filter((b) => b.textContent === 'Open in lane').length === 1,
  )
  expect(section('Evidence').textContent).not.toContain('Open in lane')
})
