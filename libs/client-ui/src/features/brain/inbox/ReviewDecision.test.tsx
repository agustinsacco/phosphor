// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainProposalView, BrainReviewDecision, BrainStatus } from '@shared/brain'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { mockBrainJob, mockBrainProposal, mockBrainStatus } from '../mockBrainData'
import { MockExplorer } from '../mockExplorer'
import { useBrain } from '../useBrain'
import { ReviewDecision } from './ReviewDecision'
import type { DecisionKeys } from './DecisionFrame'

let root: Root
let container: HTMLDivElement
let status: BrainStatus
let proposal: BrainProposalView
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
const keys: { current: DecisionKeys } = { current: {} }
const review =
  vi.fn<(id: string, keep: BrainReviewDecision | null, revision: number) => Promise<BrainStatus>>()
const proposalRead = vi.fn<() => Promise<BrainProposalView>>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  proposal = mockBrainProposal()
  status = { ...mockBrainStatus(), jobs: [proposal.job] }
  proposalRead.mockReset().mockImplementation(async () => proposal)
  review.mockReset().mockImplementation(async () => {
    status = { ...status, jobs: [], revision: status.revision + 1 }
    return status
  })
  const explorer = new MockExplorer()
  fake = createFakePhosphor({
    'brain:status': () => status,
    'brain:proposal': proposalRead,
    'brain:review': review,
    'brain:entity': (id) => explorer.entity(id),
  })
  restore = installFakePhosphor(fake)
  useBrain.setState({ status, error: '', saving: false })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})

async function render(job = proposal.job): Promise<void> {
  await act(async () =>
    root.render(<ReviewDecision job={job} keys={keys} onContext={() => {}} onMemory={() => {}} />),
  )
}
function button(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text,
  )
}
async function click(text: string, scope: ParentNode = container): Promise<void> {
  const target = button(text, scope)
  expect(target, text).toBeDefined()
  await act(async () => target!.click())
}
async function choose(label: string, text: string): Promise<void> {
  await click(text, container.querySelector(`[aria-label="Identity for ${label}"]`)!)
}

it('sends explicit identity overrides, confirmed groups and the exact memory indexes', async () => {
  for (const identity of proposal.identities)
    identity.candidates.push({
      ...identity.candidates[0]!,
      id: `${identity.ref}-other`,
      label: 'Kestrel',
    })
  await render()
  await click('▸ 3 people and things matched without doubt · 1 memory confirms what Brain knows')
  await choose('Harbor', 'Something new')
  await choose('Harbor Ledger', 'Kestrel')
  await choose('Rina Okafor', 'Yes, Rina Okafor')
  await choose('Tom Lee', 'Someone new')
  await click('Yes, one Harbor')
  const keep = container.querySelector<HTMLInputElement>(
    `[aria-label="Keep: ${proposal.memories[0]!.summary}"]`,
  )!
  await act(async () => keep.click())
  await click('Approve 1 of 2')
  expect(review).toHaveBeenCalledWith(
    'harbor-job',
    {
      memories: [1],
      identities: { harbor: 'new', ledger: 'ledger-other', rina: 'rina', tom: 'new' },
      groups: [0],
      descriptions: [],
    },
    0,
  )
})

it('sends only what the owner answered, and answers no group for him', async () => {
  await render()
  expect(container.querySelector('[aria-label="Who is Rina Okafor?"]')).not.toBeNull()
  expect(
    container.querySelector('[aria-label="Group Harbor"] [aria-pressed="true"]')?.textContent,
  ).toBe('No')
  await click('Approve 2')
  expect(review).toHaveBeenCalledWith(
    'harbor-job',
    { memories: [0, 1], identities: {}, groups: [], descriptions: [] },
    0,
  )
})

it('ticks or unticks a whole type with its group checkbox, and only that type', async () => {
  proposal.memories[1]!.type = 'risk'
  await render()
  const all = [...container.querySelectorAll<HTMLInputElement>('[aria-label^="Keep all: "]')]
  expect(all).toHaveLength(2)
  await act(async () => all[0]!.click())
  expect(button('Approve 1 of 2')).toBeDefined()
  expect(all[1]!.checked).toBe(true)
  await act(async () => all[1]!.click())
  expect(button('Approve 0 of 2')!.disabled).toBe(true)
  expect(container.textContent).toContain('Tick a memory to approve')
})

it('approves confirmations alone, and a read again with nothing new', async () => {
  proposal.memories = []
  await render()
  await click('Approve confirmations')
  expect(review).toHaveBeenLastCalledWith(
    'harbor-job',
    { memories: [], identities: {}, groups: [], descriptions: [] },
    0,
  )
})

it('says what a read again replaces, and approves it with every memory unticked', async () => {
  proposal = { ...proposal, job: mockBrainJob({ replaces: 'old-read' }), replacingMemories: 12 }
  status = { ...status, jobs: [proposal.job] }
  useBrain.setState({ status })
  await render()
  expect(container.textContent).toContain('Replaces 12 memories from the last read')
  for (const box of container.querySelectorAll<HTMLInputElement>('[aria-label^="Keep all: "]'))
    if (box.checked) await act(async () => box.click())
  await click('Approve 0 of 2')
  expect(review.mock.calls[0]![1]!.memories).toEqual([])
})

it('recovers a failed first proposal load with Retry, then rejects with null', async () => {
  proposalRead.mockRejectedValueOnce(new Error('Harbor proposal unavailable'))
  await render()
  expect(container.textContent).toContain('Harbor proposal unavailable')
  await click('Retry')
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
  await click('Reject read')
  expect(review).toHaveBeenCalledWith('harbor-job', null, 0)
})

it('refreshes a stale review, says so, and approves the new proposal', async () => {
  review.mockImplementationOnce(async () => {
    status = { ...status, jobs: [mockBrainJob({ state: 'running' })] }
    throw new Error('Brain changed; refreshing this review')
  })
  await render()
  await click('Approve 2')
  await render(mockBrainJob({ state: 'running' }))
  expect(container.textContent).toContain('Brain changed since it was read')
  expect(container.querySelector('[aria-label="Review memories"]')).toBeNull()
  proposal = mockBrainProposal(mockBrainJob(), 1)
  await render(mockBrainJob())
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
  await click('Approve 2')
  expect(review).toHaveBeenCalledTimes(2)
  expect(review.mock.calls[1]![2]).toBe(1)
})

it('waits while Brain recomputes a review and reloads it once it is back', async () => {
  await render()
  expect(proposalRead).toHaveBeenCalledOnce()
  await render(mockBrainJob({ state: 'running' }))
  expect(container.textContent).toContain('Refreshing this review')
  await render(mockBrainJob())
  expect(proposalRead).toHaveBeenCalledTimes(2)
})

it('answers a and r through the keys the Inbox forwards', async () => {
  await render()
  await act(async () => keys.current.primary?.())
  expect(review).toHaveBeenLastCalledWith('harbor-job', expect.objectContaining({ groups: [] }), 0)
  await act(async () => keys.current.reject?.())
  expect(review).toHaveBeenLastCalledWith('harbor-job', null, 0)
})

it('regression: counts a plainly new person apart from the ones matched without doubt', async () => {
  proposal.identities.push({
    ...proposal.identities[0]!,
    ref: 'kestrel',
    label: 'Kestrel',
    kind: 'team',
    decision: 'new',
    entityId: null,
    candidates: [],
    auto: false,
  })
  await render()
  expect(
    button(
      '▸ 3 people and things matched without doubt · 1 new person or thing · 1 memory confirms what Brain knows',
    ),
  ).toBeDefined()
})
