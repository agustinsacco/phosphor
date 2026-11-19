// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainProposalView, BrainReviewDecision, BrainStatus } from '@shared/brain'
import {
  BRAIN_NEVER_READ_REFRESH_REFUSAL,
  BRAIN_REVIEW_CHANGED,
  BRAIN_REVIEW_REFRESHING,
} from '@shared/brain-review'
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
      descriptions: [],
      memories: [1],
      identities: { harbor: 'new', ledger: 'ledger-other', rina: 'rina', tom: 'new' },
      groups: [0],
      confirmations: [],
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
    { descriptions: [], confirmations: [], memories: [0, 1], identities: {}, groups: [] },
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
    { descriptions: [], confirmations: [], memories: [], identities: {}, groups: [] },
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
    status = { ...status, jobs: [mockBrainJob({ state: 'refreshing' })] }
    throw new Error('Brain changed; refreshing this review')
  })
  await render()
  await click('Approve 2')
  await render(mockBrainJob({ state: 'refreshing' }))
  expect(container.textContent).toContain('Brain changed since it was read')
  expect(container.querySelector('[aria-label="Review memories"]')).toBeNull()
  proposal = mockBrainProposal(mockBrainJob(), 1)
  await render(mockBrainJob())
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
  await click('Approve 2')
  expect(review).toHaveBeenCalledTimes(2)
  expect(review.mock.calls[1]![2]).toBe(1)
})

it('regression: keeps a refusal that cannot refresh beside Reject, with the owner’s ticks', async () => {
  review.mockRejectedValueOnce(new Error(BRAIN_NEVER_READ_REFRESH_REFUSAL))
  await render()
  const keep = container.querySelector<HTMLInputElement>(
    `[aria-label="Keep: ${proposal.memories[0]!.summary}"]`,
  )!
  await act(async () => keep.click())
  await click('Approve 1 of 2')
  const bar = container.querySelector('[aria-label="Decision actions"]')!
  expect(bar.textContent).toContain(BRAIN_NEVER_READ_REFRESH_REFUSAL)
  expect(button('Reject read', bar)).toBeDefined()
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
  expect(
    container.querySelector<HTMLInputElement>(
      `[aria-label="Keep: ${proposal.memories[0]!.summary}"]`,
    )!.checked,
  ).toBe(false)
  expect(proposalRead).toHaveBeenCalledOnce()
})

it('regression: shows a load refusal that cannot refresh with Retry, not as refreshing', async () => {
  proposalRead.mockRejectedValueOnce(new Error(BRAIN_NEVER_READ_REFRESH_REFUSAL))
  await render()
  expect(container.textContent).toContain(BRAIN_NEVER_READ_REFRESH_REFUSAL)
  expect(container.textContent).not.toContain('Refreshing this review')
  await click('Retry')
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
})

it('reloads the review on either exact reload sentence', async () => {
  for (const sentence of [BRAIN_REVIEW_CHANGED, BRAIN_REVIEW_REFRESHING]) {
    review.mockRejectedValueOnce(new Error(sentence))
    await render()
    const loads = proposalRead.mock.calls.length
    await click('Approve 2')
    expect(proposalRead.mock.calls.length).toBe(loads + 1)
  }
})

it('waits while Brain recomputes a review and reloads it once it is back', async () => {
  await render()
  expect(proposalRead).toHaveBeenCalledOnce()
  await render(mockBrainJob({ state: 'refreshing' }))
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

it('holds temporary and personal claims last and unticked, and sends one once ticked', async () => {
  const base = proposal.memories[0]!
  proposal.memories.push(
    { ...base, index: 2, hold: 'temporary', type: 'open', summary: 'Tom Lee is out until Friday.' },
    { ...base, index: 3, hold: 'personal', type: 'fact', summary: 'Rina Okafor seemed tired.' },
  )
  await render()
  const groups = container.querySelectorAll('[aria-label="Proposed memories"] > section')
  expect([...groups].map((group) => group.getAttribute('aria-label')).slice(-2)).toEqual([
    'Probably temporary',
    'About a person',
  ])
  for (const group of [...groups].slice(-2)) {
    expect(group.textContent).toContain('Not kept unless you tick it')
    expect([...group.querySelectorAll('input')].some((box) => box.checked)).toBe(false)
  }
  const temporary = '[aria-label="Keep: Tom Lee is out until Friday."]'
  await act(async () => container.querySelector<HTMLInputElement>(temporary)!.click())
  await click('Approve 3 of 4')
  expect(review.mock.calls[0]![1]!.memories).toEqual([0, 1, 2])
})

it('shows a held confirmation in its held group, unticked, and sends its own index once ticked', async () => {
  const plain = proposal.confirmations[0]!
  proposal.confirmations.push({
    id: 'memory-held',
    summary: 'Rina Okafor owns the Ledger migration.',
    claim: { ...plain.claim, hold: 'personal', summary: 'Rina Okafor is up for promotion.' },
  })
  await render()
  expect(
    button('▸ 3 people and things matched without doubt · 1 memory confirms what Brain knows'),
  ).toBeDefined()
  const group = container.querySelector('[aria-label="About a person"]')!
  expect(group.textContent).toContain('Not kept unless you tick it')
  const box = group.querySelector<HTMLInputElement>(
    '[aria-label="Keep: Rina Okafor is up for promotion."]',
  )!
  expect(box.checked).toBe(false)
  expect(button('Approve 2 of 3')).toBeDefined()
  await act(async () => box.click())
  await click('Approve 3')
  expect(review).toHaveBeenLastCalledWith(
    'harbor-job',
    { descriptions: [], confirmations: [1], memories: [0, 1], identities: {}, groups: [] },
    0,
  )
})

it('approves ordinary confirmations while a held one stays unticked', async () => {
  proposal.memories = []
  const plain = proposal.confirmations[0]!
  proposal.confirmations = [
    plain,
    { ...plain, id: 'm-tom', claim: { ...plain.claim, hold: 'personal' } },
  ]
  await render()
  expect(container.textContent).toContain('1 memory confirms what Brain knows')
  await click('Approve confirmations')
  expect(review.mock.calls[0]![1]).toMatchObject({ memories: [], confirmations: [] })
})

it('blocks Approve when the only thing to save is a held confirmation nobody ticked', async () => {
  proposal.memories = []
  proposal.confirmations[0]!.claim.hold = 'temporary'
  await render()
  expect(container.textContent).not.toContain('confirms what Brain knows')
  expect(button('Approve 0 of 1')!.disabled).toBe(true)
  expect(container.textContent).toContain('Tick a memory to approve')
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('[aria-label="Probably temporary"] [aria-label^="Keep: "]')!
      .click(),
  )
  await click('Approve 1')
  expect(review.mock.calls[0]![1]).toMatchObject({ memories: [], confirmations: [0] })
})

it('asks a required question with no default and blocks Approve until it is answered', async () => {
  proposal.identities.find((identity) => identity.ref === 'rina')!.required = true
  await render()
  const card = container.querySelector('[aria-label="Who is Rina Okafor?"]')!
  expect(card.textContent).toContain('Needs an answer')
  expect(card.querySelector('[aria-pressed="true"]')).toBeNull()
  expect(button('Approve 2')!.disabled).toBe(true)
  expect(container.querySelector('[aria-label="Decision actions"]')!.textContent).toContain(
    'Answer 1 question',
  )
  await act(async () => keys.current.primary?.())
  expect(review).not.toHaveBeenCalled()
  await choose('Rina Okafor', 'Yes, Rina Okafor')
  expect(container.textContent).not.toContain('Answer 1 question')
  await click('Approve 2')
  expect(review).toHaveBeenCalledWith(
    'harbor-job',
    {
      descriptions: [],
      confirmations: [],
      memories: [0, 1],
      identities: { rina: 'rina' },
      groups: [],
    },
    0,
  )
})

it('replaces a stored description only when ticked for a record the owner kept', async () => {
  proposal.identities.find((identity) => identity.ref === 'rina')!.description =
    'Leads the Ledger team'
  await render()
  await choose('Rina Okafor', 'Yes, Rina Okafor')
  expect(container.textContent).toContain('Brain has: Ledger migration owner')
  const use = [...container.querySelectorAll('label')].find(
    (label) => label.textContent === 'Use this read’s description for Rina Okafor',
  )!
  await act(async () => use.querySelector('input')!.click())
  await click('Approve 2')
  expect(review).toHaveBeenLastCalledWith(
    'harbor-job',
    {
      descriptions: ['rina'],
      confirmations: [],
      memories: [0, 1],
      identities: { rina: 'rina' },
      groups: [],
    },
    0,
  )
  await choose('Rina Okafor', 'Someone new')
  expect(container.textContent).not.toContain('Use this read’s description')
  await click('Approve 2')
  expect(review).toHaveBeenLastCalledWith(
    'harbor-job',
    {
      descriptions: [],
      confirmations: [],
      memories: [0, 1],
      identities: { rina: 'new' },
      groups: [],
    },
    0,
  )
})

it('makes Reject the primary action for a lane Brain is set never to read', async () => {
  proposal = { ...proposal, job: mockBrainJob({ title: 'Rina Okafor 1:1' }) }
  await render()
  expect(container.textContent).toContain(
    'You set Brain to never read this lane. Reject to discard this read.',
  )
  expect(button('Reject read')!.classList.contains('bg-accent')).toBe(true)
  expect(button('Approve 2')!.classList.contains('bg-accent')).toBe(false)
  await act(async () => keys.current.primary?.())
  expect(review).toHaveBeenLastCalledWith('harbor-job', null, 0)
})

it('names an untitled lane “Untitled lane”, which no title rule matches', async () => {
  proposal = { ...proposal, job: mockBrainJob({ title: '' }) }
  status = {
    ...status,
    prefs: { ...status.prefs, neverRead: { titles: ['lane'], sessionIds: [] } },
  }
  useBrain.setState({ status })
  await render()
  expect(container.querySelector('h2')?.textContent).toBe('Untitled lane')
  expect(container.textContent).not.toContain('never read this lane')
  expect(button('Approve 2')!.classList.contains('bg-accent')).toBe(true)
})

it('says a read of new messages reads only those', async () => {
  proposal = { ...proposal, job: mockBrainJob({ fromLeafId: 'leaf-0' }) }
  await render()
  expect(container.querySelector('[aria-label="Decision actions"]')!.textContent).toContain(
    'Reads new messages only',
  )
  expect(container.textContent).not.toContain('never read this lane')
})
