// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { PromptHost } from '@/components/PromptHost'
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
let searchRequest = 0
const browse = vi.fn<MockExplorer['browse']>()
const recent = vi.fn<MockExplorer['recent']>()
const entity = vi.fn<MockExplorer['entity']>()
const memory = vi.fn<MockExplorer['memory']>()
const connections = vi.fn<MockExplorer['connections']>()
const memories = vi.fn<MockExplorer['memories']>()
const forget = vi.fn(() => ({ ...mockBrainStatus(), revision: 1 }))
const onOpenRead = vi.fn()
function Harness(): React.JSX.Element {
  state = useExplorer()
  return (
    <>
      <BrainKnowledge state={state} searchRequest={searchRequest} onOpenRead={onOpenRead} />
      <PromptHost />
    </>
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  searchRequest = 0
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
  forget.mockClear()
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
    'brain:forget': forget,
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const render = () => act(async () => root.render(<Harness />))
const section = (name: string): HTMLElement => container.querySelector(`[aria-label="${name}"]`)!
function button(label: string, inside: ParentNode = container): HTMLButtonElement {
  return [...inside.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label,
  )!
}
const click = (label: string, inside?: ParentNode) =>
  act(async () => {
    const target = button(label, inside)
    expect(target, label).toBeDefined()
    target.click()
  })
const visit = (kind: 'entity' | 'memory', id: string, label = id) =>
  act(async () => state.onVisit({ kind, id, label }))
const key = (key: string, target: Element = container) =>
  act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
const search = () => container.querySelector<HTMLInputElement>('[role="combobox"]')!
async function type(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), value)
    search().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => vi.advanceTimersByTimeAsync(200))
}
const rows = () => [...section('People and things').querySelectorAll('[role="option"]')]
const tab = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) =>
    t.textContent?.startsWith(name),
  )!

it('lists the index thirty at a time with only present kinds, and opens a profile', async () => {
  await render()
  expect(rows()).toHaveLength(30)
  expect(browse).toHaveBeenLastCalledWith(null, 0, 30, 'connected')
  // Each kind chip carries its count from the index page.
  expect(button('People2', section('Kinds'))).toBeDefined()
  const chips = [...section('Kinds').querySelectorAll('button')].map((b) => b.textContent ?? '')
  expect(chips.some((chip) => chip.startsWith('Events'))).toBe(false)
  await click('People2', section('Kinds'))
  expect(browse).toHaveBeenLastCalledWith('person', 0, 30, 'connected')
  expect(rows().map((row) => row.textContent)).toEqual(['Rina Okafor2', 'Tom Lee1'])
  await act(async () => (rows()[0] as HTMLButtonElement).click())
  expect(state.visit).toMatchObject({ kind: 'entity', id: 'rina' })
  expect(section('Rina Okafor').querySelector('h2')?.textContent).toBe('Rina Okafor')
  expect(rows()[0]!.getAttribute('aria-current')).toBe('true')
})

it('counts every kind and the filter total, and sorts the index as chosen', async () => {
  await render()
  const all = explorer.browse(null, 0, 100, 'connected')
  const kinds = section('Kinds')
  expect(button(`All${all.total}`, kinds)).toBeDefined()
  expect(section('Index').textContent).toContain(`${all.total} people and things`)
  await click('People2', kinds)
  expect(section('Index').textContent).toContain('2 people and things')
  // Counts per kind ignore the filter.
  expect(button(`All${all.total}`, kinds)).toBeDefined()
  const sort = container.querySelector<HTMLSelectElement>('select[aria-label="Sort"]')!
  await act(async () => {
    sort.value = 'name'
    sort.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(browse).toHaveBeenLastCalledWith('person', 0, 30, 'name')
  await click(`All${all.total}`, kinds)
  const byName = explorer.browse(null, 0, 30, 'name').items.map((item) => item.entity.label)
  expect(byName).not.toEqual(all.items.slice(0, 30).map((item) => item.entity.label))
  expect(rows().map((row) => row.querySelector('span.flex-1')?.textContent)).toEqual(byName)
  await type('Harbor')
  expect(container.querySelector('select[aria-label="Sort"]')).toBeNull()
  expect(section('Index').textContent).toContain('By best match')
})

it('pages the index by reloading every shown row in one bounded pass', async () => {
  explorer.entities.push(
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `kestrel-${i}`,
      label: `Kestrel part ${i + 1}`,
      kind: 'component' as const,
      aliases: [],
      description: '',
    })),
  )
  for (const [index, extra] of explorer.entities.slice(-20).entries())
    explorer.details.push({
      ...explorer.details[0]!,
      memory: {
        ...explorer.details[0]!.memory,
        id: `kestrel-memory-${index}`,
        entityIds: [extra.id, 'harbor'],
        links: [],
      },
    })
  await render()
  expect(rows()).toHaveLength(30)
  await click('Show more')
  expect(browse).toHaveBeenLastCalledWith(null, 0, 60, 'connected')
  expect(rows()).toHaveLength(50)
  expect(button('Show more')).toBeUndefined()
})

it('recovers a failed first index load with Retry', async () => {
  browse.mockImplementationOnce(() => {
    throw new Error('Index failed')
  })
  await render()
  expect(section('Index').textContent).toContain('Index failed')
  await click('Retry', section('Index'))
  expect(rows().length).toBeGreaterThan(0)
})

it('searches people, things and memories, and walks with the arrows and Enter', async () => {
  await render()
  await type('Harbor Ledger')
  expect(section('Memories').textContent).toContain('Harbor Ledger is built for Harbor.')
  expect(container.textContent).toMatch(/\d+ results?/)
  await key('ArrowDown', search())
  await key('Enter', search())
  expect(state.visit).toMatchObject({ kind: 'entity' })
  await key('Escape', search())
  expect(search().value).toBe('')
  expect(document.activeElement).not.toBe(search())
})

it('opens a searched memory inside the profile of the first thing it names', async () => {
  await render()
  await type('built for Harbor')
  const option = [...section('Memories').querySelectorAll<HTMLButtonElement>('[role="option"]')][0]!
  await act(async () => option.click())
  expect(state.visit).toMatchObject({ kind: 'entity', id: 'ledger', memoryId: 'memory-0' })
  expect(state.trail.items).toHaveLength(1)
  const open = section('Harbor Ledger').querySelector('[aria-expanded="true"]')!
  expect(open.textContent).toContain('Harbor Ledger is built for Harbor.')
  expect(section('Harbor Ledger').querySelector('mark')?.textContent).toBe(
    'Harbor Ledger is built for Harbor.',
  )
})

it('focuses the index search when the page asks', async () => {
  await render()
  expect(document.activeElement).not.toBe(search())
  searchRequest = 1
  await render()
  expect(document.activeElement).toBe(search())
})

it('shows a profile header with counts, every other name once, and tabs with counts', async () => {
  await render()
  await visit('entity', 'ledger', 'Harbor Ledger')
  const profile = section('Harbor Ledger')
  expect(profile.querySelector('h2 + span')?.textContent).toBe('project')
  expect(profile.textContent).toMatch(/\d+ memories · \d+ links · from 1 lane · last learned /)
  expect(profile.textContent).toContain('Billing project for Harbor')
  expect(profile.textContent).toContain('Also called')
  expect(profile.textContent!.match(/Ledger(?!\w)/g)!.length).toBeGreaterThan(0)
  expect(tab('Memories').textContent).toBe('Memories 3')
  expect(tab('Connections').textContent).toMatch(/^Connections \d+$/)
  expect(tab('Lanes').textContent).toBe('Lanes 1')
  expect(tab('Map')).toBeUndefined()
})

it('filters memories by type, lane and state, and opens a row in place', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  await click('Decisions1', section('Memory types'))
  expect(memories.mock.lastCall?.[1].types).toEqual(['decision'])
  const select = section('State') as HTMLSelectElement
  await act(async () => {
    select.value = 'all'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(memories.mock.lastCall?.[1].states).toEqual(['active', 'disputed', 'superseded'])
  const row = section('Harbor').querySelector<HTMLButtonElement>('[aria-expanded="false"]')!
  await act(async () => row.click())
  expect(row.getAttribute('aria-expanded')).toBe('true')
  await click('See the read')
  expect(onOpenRead).toHaveBeenCalledWith('harbor-read')
  await click('Harbor Ledger')
  expect(state.visit).toMatchObject({ kind: 'entity', id: 'ledger' })
})

it('asks before forgetting a memory, which is permanent', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  await act(async () =>
    section('Harbor').querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click(),
  )
  await click('Forget')
  expect(document.body.textContent).toContain('Forget cannot be undone.')
  expect(forget).not.toHaveBeenCalled()
  await click('Forget permanently', document.body)
  expect(forget).toHaveBeenCalledWith('memory-0')
})

it('pages memories and recovers a failed page', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  memories.mockImplementationOnce(() => {
    throw new Error('Memories failed')
  })
  await click('Show more memories')
  expect(section('Harbor').textContent).toContain('Memories failed')
  await click('Retry', section('Harbor'))
  expect(section('Harbor').textContent).not.toContain('Memories failed')
  expect(section('Harbor').textContent).toMatch(/2\d shown · newest first/)
})

it('lists one row per connection label, walks on click and pages with Retry', async () => {
  // A second memory says the same thing: the neighbour shows two supporting memories.
  const first = explorer.details[0]!
  explorer.details.push({
    ...first,
    memory: {
      ...first.memory,
      id: 'memory-again',
      links: [{ ...first.memory.links[0]!, id: 'link-again', memoryId: 'memory-again' }],
    },
  })
  await render()
  await visit('entity', 'harbor', 'Harbor')
  await act(async () => tab('Connections').click())
  const table = section('Connections')
  expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toContain('Contains24')
  connections.mockImplementationOnce(() => {
    throw new Error('Connections failed')
  })
  await click('Show more', table)
  expect(table.textContent).toContain('Connections failed')
  await click('Retry', table)
  expect(table.textContent).not.toContain('Connections failed')
  await click('Harbor Ledger2 memories', table)
  expect(state.visit).toMatchObject({ id: 'ledger' })
})

it('lists the lanes a profile came from and filters its memories by one', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  await act(async () => tab('Lanes').click())
  expect(section('Lanes').querySelector('th')?.textContent).toBe('Harbor planning26 memories')
  await click('Its memories', section('Lanes'))
  expect(tab('Memories').getAttribute('aria-selected')).toBe('true')
  expect(memories.mock.lastCall?.[1].sessionId).toBe('harbor-lane')
})

it('recovers a failed profile and a failed memory with Retry', async () => {
  await render()
  entity.mockImplementationOnce(() => {
    throw new Error('Entity failed')
  })
  await visit('entity', 'harbor')
  expect(section('Profile').textContent).toContain('Entity failed')
  await click('Retry', section('Profile'))
  expect(section('Harbor')).not.toBeNull()
  memory.mockImplementationOnce(() => {
    throw new Error('Memory failed')
  })
  await visit('memory', 'memory-0')
  expect(section('Profile').textContent).toContain('Memory failed')
  await click('Retry', section('Profile'))
  expect(state.visit).toMatchObject({ id: 'ledger', memoryId: 'memory-0' })
})

it('goes back and forward with the buttons and [ ], never from a text field', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  await visit('entity', 'ledger', 'Harbor Ledger')
  await visit('entity', 'rina', 'Rina Okafor')
  await visit('entity', 'tom', 'Tom Lee')
  expect(section('Brain trail').textContent).not.toContain('Harbor›')
  await click('Back', section('Brain trail'))
  expect(state.visit?.id).toBe('rina')
  await key('[', section('Profile'))
  expect(state.visit?.id).toBe('ledger')
  await key(']', section('Profile'))
  expect(state.visit?.id).toBe('rina')
  await key('[', search())
  expect(state.visit?.id).toBe('rina')
  await click('Harbor Ledger', section('Brain trail'))
  expect(state.visit?.id).toBe('ledger')
})

it('draws the selection and its neighbours, capped with a way to the rest', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  const map = section('Map')
  expect(
    map.querySelector('[aria-label^="Harbor, organization"]')?.getAttribute('aria-label'),
  ).toBe('Harbor, organization, 26 memories (selected)')
  expect(map.querySelectorAll('g[role="button"]').length).toBe(25)
  expect(section('Legend').textContent).toContain('Systems')
  await click('+1 more', map)
  expect(tab('Connections').getAttribute('aria-selected')).toBe('true')
  const ledger = map.querySelector<SVGGElement>('[aria-label^="Harbor Ledger,"]')!
  await key('Enter', ledger)
  expect(state.visit).toMatchObject({ id: 'ledger' })
})

it('opens the full map in place of profile and map, and goes back', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  await click('Full map', section('Map'))
  expect(section('Full map')).not.toBeNull()
  expect(section('Knowledge graph')).not.toBeNull()
  expect(section('Map')).toBeNull()
  await click('Back to profile')
  expect(section('Full map')).toBeNull()
  expect(section('Harbor')).not.toBeNull()
})

it('regression: Escape clears the full map selection, as its Clear selection hint says', async () => {
  await render()
  await click('Full map', section('Map'))
  await click('Focus Harbor', section('Graph entities'))
  expect(button('Clear selection')).toBeDefined()
  await key('Escape', button('Focus Harbor'))
  expect(button('Clear selection')).toBeUndefined()
  expect(section('Full map')).not.toBeNull()
})

it('regression: Clear selection clears the profile it was opened from on the full map', async () => {
  await render()
  await visit('entity', 'harbor', 'Harbor')
  await click('Full map', section('Map'))
  expect(button('Focus Harbor').getAttribute('aria-pressed')).toBe('true')
  await click('Clear selection')
  expect(button('Clear selection')).toBeUndefined()
  expect(button('Focus Harbor').getAttribute('aria-pressed')).toBe('false')
})

it('regression: at 1060px or less the start page still opens the full map', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly report: ResizeObserverCallback) {}
      observe(): void {
        this.report(
          [{ contentRect: { width: 900, height: 600 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }
      disconnect(): void {}
    },
  )
  await render()
  expect(section('Map')).toBeNull()
  await click('Full map', section('Profile'))
  expect(section('Full map')).not.toBeNull()
  await click('Close full map')
  expect(section('Recently learned')).not.toBeNull()
})

it('starts with what Brain learned last, and says what to do when Brain is empty', async () => {
  await render()
  expect(section('Recently learned').textContent).toContain('Harbor planning')
  explorer.entities = []
  explorer.details = []
  act(() => root.unmount())
  root = createRoot(container)
  await render()
  expect(section('Index').textContent).toContain('Queue for knowledge extraction')
  expect(section('Recently learned').textContent).toContain('Queue for knowledge extraction')
})

it('uses singular counts', async () => {
  await render()
  await visit('entity', 'tom', 'Tom Lee')
  expect(section('Tom Lee').textContent).toContain('1 memory ·')
  expect(section('Tom Lee').textContent).not.toContain('1 memories')
})

it('shows who leads a team as Leads, and the team as Led by', async () => {
  await render()
  await visit('entity', 'rina', 'Rina Okafor')
  await act(async () => tab('Connections').click())
  const heads = () => [...section('Connections').querySelectorAll('th')].map((th) => th.textContent)
  expect(heads().some((head) => head?.startsWith('Leads'))).toBe(true)
  await click('Ledger team1 memory', section('Connections'))
  await act(async () => tab('Connections').click())
  expect(heads().some((head) => head?.startsWith('Led by'))).toBe(true)
})

it('regression: follows a merged-away linked entity to the survivor returned by Brain', async () => {
  await render()
  entity.mockImplementation((id) => explorer.entity(id === 'rina-old' ? 'rina' : id))
  await visit('entity', 'rina-old', 'Rina')
  expect(state.visit).toMatchObject({ kind: 'entity', id: 'rina', label: 'Rina Okafor' })
  expect(memories.mock.lastCall?.[0]).toBe('rina')
  expect(container.textContent).not.toContain('Brain entity not found.')
})

it('follows the survivor when the selected entity merges during Defrag', async () => {
  await render()
  await visit('entity', 'tom', 'Tom Lee')
  explorer.merge('tom', 'rina')
  await act(async () => useBrain.setState({ status: { ...mockBrainStatus(), revision: 1 } }))
  expect(state.visit).toMatchObject({ kind: 'entity', id: 'rina', label: 'Rina Okafor' })
  expect(memories.mock.lastCall?.[0]).toBe('rina')
})
