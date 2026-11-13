// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainStatus, BrainProposalView, BrainReviewDecision } from '@shared/brain'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { BrainPage } from './BrainPage'
import { mockBrainJob, mockBrainProposal, mockBrainStatus } from './mockBrainData'
import { MockExplorer } from './mockExplorer'
import { useBrain } from './useBrain'

let root: Root
let container: HTMLDivElement
let status: BrainStatus
let proposal: BrainProposalView
let explorer: MockExplorer
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
const review =
  vi.fn<
    (id: string, decision: BrainReviewDecision | null, revision: number) => Promise<BrainStatus>
  >()
const proposalRead = vi.fn<() => Promise<BrainProposalView>>()
const find = vi.fn<MockExplorer['find']>()
const entity = vi.fn<MockExplorer['entity']>()
const overview = vi.fn<MockExplorer['graph']>()
const neighbourhood = vi.fn<MockExplorer['graph']>()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  status = { ...mockBrainStatus(), prefs: { enabled: true, recall: true, review: true } }
  proposal = mockBrainProposal()
  explorer = new MockExplorer()
  proposalRead.mockReset().mockImplementation(async () => proposal)
  review.mockReset().mockImplementation(async () => {
    status = { ...status, jobs: [], revision: status.revision + 1 }
    return status
  })
  find.mockReset().mockImplementation((q, n) => explorer.find(q, n))
  entity.mockReset().mockImplementation((id) => explorer.entity(id))
  overview.mockReset().mockImplementation(() => explorer.graph(null))
  neighbourhood.mockReset().mockImplementation((id, hops) => explorer.graph(id, hops))
  fake = createFakePhosphor({
    'brain:status': () => status,
    'brain:overview': () => overview(null),
    'brain:neighbourhood': (id, hops) => neighbourhood(id, hops),
    'brain:find': find,
    'brain:entity': entity,
    'brain:connections': (id, predicate, direction, cursor) =>
      explorer.connections(id, predicate, direction, cursor),
    'brain:entityMemories': (id, filter, cursor) => explorer.memories(id, filter, cursor),
    'brain:memory': (id) => explorer.memory(id),
    'brain:merge': (source, target) => {
      explorer.merge(source, target)
      return { ...status, revision: ++status.revision }
    },
    'brain:retry': () => status,
    'brain:path': (from, to) => explorer.path(from, to),
    'brain:proposal': proposalRead,
    'brain:review': review,
    'brain:forget': (id) => {
      explorer.details = explorer.details.filter((d) => d.memory.id !== id)
      return { ...status, revision: ++status.revision }
    },
  })
  restore = installFakePhosphor(fake)
  useBrain.setState({ status: null, saving: false, error: '' })
  useSettingsUiStore.setState({ open: false })
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
const render = async (): Promise<void> => {
  await act(async () => root.render(<BrainPage />))
}
async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text || b.getAttribute('aria-label') === text,
  )
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
async function search(
  value: string,
  selector = '[aria-label="Find a person, project or memory"]',
): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(selector)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => vi.advanceTimersByTimeAsync(200))
}
async function chooseHarbor(): Promise<void> {
  await search('Harbor')
  const option = container.querySelector<HTMLButtonElement>('[role="option"]')!
  await act(async () => option.click())
}

it('loads a bounded overview, opens settings and refuses Brain on browser platforms', async () => {
  await render()
  expect(overview).toHaveBeenCalledOnce()
  await click('Settings')
  expect(useSettingsUiStore.getState().open).toBe(true)
  const calls = overview.mock.calls.length
  await act(async () =>
    root.render(
      <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
        <BrainPage />
      </PlatformProvider>,
    ),
  )
  expect(container.textContent).toContain('Brain is available on Desktop')
  expect(overview).toHaveBeenCalledTimes(calls)
})
it('debounces find, chooses with keyboard, traverses connections and supports back/forward', async () => {
  await render()
  await search('Harbor')
  expect(find).toHaveBeenCalledWith('Harbor', 12)
  const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  )
  expect(container.querySelector('[aria-label="Entity detail"]')?.textContent).toContain('Harbor')
  expect(container.textContent).toContain('Contains · 24')
  expect(neighbourhood).toHaveBeenLastCalledWith('harbor', 1)
  await click('Harbor Ledger')
  expect(container.textContent).toContain('For customer · 1')
  await act(async () =>
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }),
    ),
  )
  expect(neighbourhood).toHaveBeenLastCalledWith('harbor', 1)
  await click('Forward')
  expect(neighbourhood).toHaveBeenLastCalledWith('ledger', 1)
  await click('2 hops')
  expect(neighbourhood).toHaveBeenLastCalledWith('ledger', 2)
})
it('pages connections and memories and shows link support and state on memory detail', async () => {
  await render()
  await chooseHarbor()
  const connections = container.querySelector('[aria-label="Connections"]')!
  expect(connections.textContent).not.toContain('Harbor component 25')
  await click('Show more')
  expect(connections.textContent).toContain('Harbor component 25')
  await click('Show more memories')
  expect(container.querySelector('[aria-label="Entity memories"]')?.textContent).toContain(
    'Harbor component 25 is part of Harbor.',
  )
  const memory = container.querySelector<HTMLButtonElement>(
    '[aria-label="Entity memories"] button',
  )!
  await act(async () => memory.click())
  const detail = container.querySelector('[aria-label="Memory detail"]')!
  expect(detail.textContent).toContain('active')
  expect(detail.textContent).toContain('→ for customer →')
  expect(detail.querySelectorAll('blockquote').length).toBeGreaterThan(0)
})
it('recovers a failed entity read and reloads on reset generation', async () => {
  entity.mockImplementationOnce(() => {
    throw new Error('Harbor temporarily unavailable')
  })
  await render()
  await chooseHarbor()
  expect(container.textContent).toContain('Harbor temporarily unavailable')
  await click('Retry')
  expect(container.querySelector('[aria-label="Entity detail"]')).not.toBeNull()
  await act(async () => useBrain.setState({ status: { ...status, generation: 'reset-1' } }))
  expect(container.querySelector('[aria-label="Entity detail"]')).toBeNull()
  expect(overview).toHaveBeenCalledTimes(2)
})
it('renders supported path chains and highlights a chosen route', async () => {
  await render()
  await chooseHarbor()
  await click('Find a path to…')
  await search('Rina', '[aria-label="Find an entity"]')
  const option = container.querySelector<HTMLButtonElement>(
    '[aria-label="Choose entity"] [role="option"]',
  )!
  await act(async () => option.click())
  const paths = container.querySelector('[aria-label="Supported paths"]')!
  expect(paths.textContent).toContain('Rina Okafor owns Harbor Ledger migrations.')
  await click('Highlight route 1')
  expect(
    [...paths.querySelectorAll('button')]
      .find((b) => b.textContent === 'Highlight route 1')
      ?.getAttribute('aria-pressed'),
  ).toBe('true')
})
it('builds a v4 review with identity overrides, group yes and memory select none/all', async () => {
  status.jobs = [mockBrainJob()]
  await render()
  await click('Review')
  expect(container.textContent).not.toContain('lane summary')
  await click('Select none · all new')
  await click('Select all groups')
  await click('Select no memories')
  await click('Select all memories')
  const picker = container.querySelector<HTMLSelectElement>(
    '[aria-label="Identity for Rina Okafor"]',
  )!
  await act(async () => {
    picker.value = 'rina'
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click('Approve 2')
  expect(review).toHaveBeenCalledWith(
    'harbor-job',
    {
      memories: [0, 1],
      identities: { harbor: 'new', ledger: 'new', rina: 'rina', tom: 'new' },
      groups: [0],
    },
    0,
  )
})
it('shows a stale review error, refreshes the proposal, and can approve again', async () => {
  status.jobs = [mockBrainJob()]
  review.mockImplementationOnce(async () => {
    status = { ...status, jobs: [mockBrainJob({ state: 'running' })] }
    throw new Error('Brain changed; refreshing this review')
  })
  await render()
  await click('Review')
  await click('Approve 2')
  expect(container.textContent).toContain('Brain changed; refreshing this review')
  expect(container.querySelector('[aria-label="Review memories"]')).toBeNull()
  status = { ...status, jobs: [mockBrainJob()] }
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
  expect(container.textContent).not.toContain('Brain changed; refreshing this review')
  await click('Approve 2')
  expect(review).toHaveBeenCalledTimes(2)
})
it('recovers a failed first proposal load and rejects with null', async () => {
  status.jobs = [mockBrainJob()]
  proposalRead.mockRejectedValueOnce(new Error('Harbor proposal unavailable'))
  await render()
  await click('Review')
  expect(container.textContent).toContain('Harbor proposal unavailable')
  await click('Retry')
  await click('Reject all')
  expect(review).toHaveBeenCalledWith('harbor-job', null, 0)
})

it('waits for a recomputed job to return to review before reloading its proposal', async () => {
  status.jobs = [mockBrainJob()]
  await render()
  await click('Review')
  expect(proposalRead).toHaveBeenCalledOnce()
  await act(async () =>
    useBrain.setState({ status: { ...status, jobs: [mockBrainJob({ state: 'running' })] } }),
  )
  expect(container.textContent).toContain('Waiting for the job to return to review')
  await act(async () => useBrain.setState({ status: { ...status, jobs: [mockBrainJob()] } }))
  expect(proposalRead).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
})

it('pages review identities at twenty and applies select-all across pages', async () => {
  status.jobs = [mockBrainJob()]
  const base = proposal.identities[0]!
  proposal.identities = Array.from({ length: 25 }, (_, i) => ({
    ...base,
    ref: `n${i}`,
    label: `Harbor team ${i}`,
    decision: 'uncertain',
  }))
  await render()
  await click('Review')
  const section = container.querySelector('[aria-label="Who/what is this?"]')!
  expect(section.querySelectorAll('select')).toHaveLength(20)
  await click('Next')
  expect(section.querySelectorAll('select')).toHaveLength(5)
  await click('Select none · all new')
  await click('Approve 2')
  expect(Object.keys(review.mock.calls[0]![1]!.identities)).toHaveLength(25)
})

it('filters disputed memories and retries failed jobs', async () => {
  const retry = vi.spyOn(fake.api, 'invoke')
  await render()
  await chooseHarbor()
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Memory state"]')!
  await act(async () => {
    select.value = 'disputed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const memories = container.querySelector('[aria-label="Entity memories"]')!
  expect(memories.textContent).toContain('Harbor component 1 is part of Harbor.')
  expect(memories.textContent).not.toContain('Harbor Ledger is built for Harbor.')
  await act(async () =>
    useBrain.setState({ status: { ...status, jobs: [mockBrainJob({ state: 'failed' })] } }),
  )
  await click('Retry')
  expect(retry).toHaveBeenCalledWith('brain:retry', 'harbor-job')
})

it('requires explicit merge confirmation and hops to the target', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  await render()
  await chooseHarbor()
  await click('Merge into…')
  await search('Rina', '[aria-label="Find an entity"]')
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Choose entity"] [role="option"]')!
      .click(),
  )
  const request = usePromptStore.getState().requests[0]!
  expect(request.title).toBe('Merge Harbor into Rina Okafor?')
  expect(request.message).toContain('The source entity is deleted')
  await act(async () => usePromptStore.getState().dismiss(request, 'MERGE'))
  expect(container.querySelector('[aria-label="Entity detail"] h2')!.textContent).toBe(
    'Rina Okafor',
  )
  expect(explorer.entities.some((entity) => entity.id === 'harbor')).toBe(false)
})

it('discards loaded connection pages when the entity revision changes', async () => {
  await render()
  await chooseHarbor()
  await click('Show more')
  expect(container.querySelector('[aria-label="Connections"]')!.textContent).toContain(
    'Harbor component 25',
  )
  explorer.details = explorer.details.filter((d) => !d.memory.entityIds.includes('component-24'))
  await act(async () => useBrain.setState({ status: { ...status, revision: 1 } }))
  const connections = container.querySelector('[aria-label="Connections"]')!
  expect(connections.textContent).not.toContain('Harbor component 25')
  expect(connections.textContent).toContain('Contains · 23')
})

it('starts memory paging again after a revision instead of retaining deleted earlier pages', async () => {
  await render()
  await chooseHarbor()
  await click('Show more memories')
  explorer.details = explorer.details.filter((d) => d.memory.id !== 'memory-0')
  await act(async () => useBrain.setState({ status: { ...status, revision: 1 } }))
  const memories = container.querySelector('[aria-label="Entity memories"]')!
  expect(memories.textContent).not.toContain('Harbor Ledger is built for Harbor.')
  expect(memories.textContent).toContain('Harbor component 1 is part of Harbor.')
  expect(memories.textContent).not.toContain('Harbor component 25 is part of Harbor.')
})

it('supports Alt+Right and empty-search Backspace without hijacking typing', async () => {
  await render()
  await chooseHarbor()
  await click('Harbor Ledger')
  const key = async (key: string, altKey = false, target: HTMLElement = document.body) => {
    await act(async () =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey, bubbles: true })),
    )
  }
  const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
  await key('Backspace', false, input)
  expect(neighbourhood).toHaveBeenLastCalledWith('ledger', 1)
  await key('ArrowLeft', true)
  expect(neighbourhood).toHaveBeenLastCalledWith('harbor', 1)
  await key('ArrowRight', true)
  expect(neighbourhood).toHaveBeenLastCalledWith('ledger', 1)
  await search('Tom')
  await key('Backspace')
  expect(neighbourhood).toHaveBeenLastCalledWith('ledger', 1)
  await key('Escape', false, input)
  await key('Backspace')
  expect(neighbourhood).toHaveBeenLastCalledWith('harbor', 1)
})

it('includes superseded memories only on request and filters by the source lane', async () => {
  explorer.details[0]!.memory.origin = { sessionId: 'ledger-lane', title: 'Ledger rollout' }
  await render()
  await chooseHarbor()
  const memories = () => container.querySelector('[aria-label="Entity memories"]')!
  expect(memories().textContent).not.toContain('Harbor component 2 is part of Harbor.')
  await act(async () =>
    memories().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  )
  expect(memories().textContent).toContain('Harbor component 2 is part of Harbor.')
  const lane = container.querySelector<HTMLSelectElement>('[aria-label="Source lane"]')!
  await act(async () => {
    lane.value = 'ledger-lane'
    lane.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(memories().textContent).toContain('Harbor Ledger is built for Harbor.')
  expect(memories().textContent).not.toContain('Harbor component 1 is part of Harbor.')
})

it('shows held claims and pages groups and memories at twenty with bulk choices across pages', async () => {
  status.jobs = [mockBrainJob()]
  proposal.groups = Array.from({ length: 21 }, (_, index) => ({ ...proposal.groups[0]!, index }))
  const base = proposal.memories[0]!
  proposal.memories = Array.from({ length: 21 }, (_, index) => ({
    ...base,
    index,
    summary: `Harbor decision ${index}`,
  }))
  await render()
  await click('Review')
  expect(container.textContent).toContain('2 held back')
  for (const label of ['Possible groups', 'Proposed memories']) {
    const section = container.querySelector(`[aria-label="${label}"]`)!
    expect(section.querySelectorAll('input[type="checkbox"]')).toHaveLength(20)
    const next = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Next')!
    await act(async () => next.click())
    expect(section.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
  }
  await click('Select all suggestions')
  await click('Select all groups')
  await click('Select no groups')
  await click('Select no memories')
  await click('Select all memories')
  await click('Approve 21')
  expect(review.mock.calls[0]![1]).toEqual({
    memories: Array.from({ length: 21 }, (_, i) => i),
    identities: { harbor: 'harbor', ledger: 'ledger', rina: 'new', tom: 'tom' },
    groups: [],
  })
})

it('cancels a merge without changing entities or navigating', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  const invokes = vi.spyOn(fake.api, 'invoke')
  await render()
  await chooseHarbor()
  await click('Merge into…')
  await search('Rina', '[aria-label="Find an entity"]')
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Choose entity"] [role="option"]')!
      .click(),
  )
  const request = usePromptStore.getState().requests[0]!
  await act(async () => usePromptStore.getState().dismiss(request, undefined))
  expect(invokes.mock.calls.some(([channel]) => channel === 'brain:merge')).toBe(false)
  expect(container.querySelector('[aria-label="Entity detail"] h2')!.textContent).toBe('Harbor')
})

it('refreshes status after a stale proposal load and recovers automatically when recomputation finishes', async () => {
  status.jobs = [mockBrainJob()]
  proposalRead.mockImplementationOnce(async () => {
    status = {
      ...status,
      jobs: [
        mockBrainJob({
          state: 'running',
          progress: { stage: 'identity', done: 1, total: 2 },
        }),
      ],
    }
    throw new Error('Brain changed; refreshing this review')
  })
  await render()
  await click('Review')
  expect(useBrain.getState().status?.jobs[0]?.state).toBe('running')
  expect(container.textContent).toContain('Brain changed; refreshing this review')
  expect(container.textContent).toContain('Matching entities 1 of 2')
  expect(container.querySelector('[aria-label="Review memories"]')).toBeNull()
  status = { ...status, jobs: [mockBrainJob()] }
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(proposalRead).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
  expect(container.textContent).not.toContain('Brain changed; refreshing this review')
})
