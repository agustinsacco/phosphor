// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { BrainReview } from './BrainReview'
import { mockBrainProposal, mockBrainStatus } from './mockBrainData'
import { useBrain } from './useBrain'

let root: Root
let container: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
let proposal = mockBrainProposal()
const review = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  proposal = mockBrainProposal()
  const status = { ...mockBrainStatus(), jobs: [proposal.job] }
  useBrain.setState({ status, saving: false, error: '' })
  review.mockReset().mockResolvedValue(status)
  fake = createFakePhosphor({ 'brain:proposal': () => proposal, 'brain:review': review })
  restore = installFakePhosphor(fake)
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})
const render = async () =>
  act(async () =>
    root.render(<BrainReview jobId={proposal.job.id} onClose={() => {}} onExtraction={() => {}} />),
  )
it('asks only suggested matches, discloses new identities and uses short options with wrapped candidate descriptions', async () => {
  const identity = proposal.identities[0]!
  identity.candidates = [
    identity.candidates[0]!,
    {
      ...identity.candidates[0]!,
      id: 'kestrel',
      label: 'Kestrel',
      description: 'Kestrel and Harbor. '.repeat(20),
    },
  ]
  proposal.identities.push({
    ...identity,
    ref: 'fresh',
    label: 'Mara Voss',
    decision: 'new',
    entityId: null,
    candidates: [],
  })
  await render()
  expect(container.textContent).toContain('Needs your call · 3')
  const disclosure = [...container.querySelectorAll('details')].find((detail) =>
    detail.querySelector('summary')?.textContent?.includes('new people and things'),
  )!
  expect(disclosure.open).toBe(false)
  expect(disclosure.textContent).toContain('2 new people and things · no decision needed')
  expect(
    disclosure.querySelector('[aria-label="Identity for Rina Okafor"] [role="radio"]'),
  ).not.toBeNull()
  expect(disclosure.querySelector('select')).toBeNull()
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Identity for Harbor"]')!
  expect([...select.options].map((option) => option.textContent)).toEqual([
    'New',
    'Harbor · organization',
    'Kestrel · organization',
  ])
  await act(async () => {
    select.value = 'kestrel'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(select.closest('article')?.querySelector('p.text-text-secondary')?.textContent).toBe(
    identity.candidates[1]!.description,
  )
})
it('uses a mixed group checkbox and applies group choices without changing another type', async () => {
  proposal.memories.push({ ...proposal.memories[0]!, index: 2, summary: 'Kestrel decision.' })
  await render()
  const all = container.querySelector<HTMLInputElement>('[aria-label="All decisions"]')!
  const first = container.querySelector<HTMLInputElement>(
    '[aria-label="Proposed memories"] article input',
  )!
  await act(async () => first.click())
  expect(all.checked).toBe(false)
  expect(all.indeterminate).toBe(true)
  await act(async () => all.click())
  expect(all.checked).toBe(true)
  await act(async () => all.click())
  expect(container.textContent).toContain('Memories · 1 of 3 selected')
  const approve = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Approve 1',
  )!
  await act(async () => approve.click())
  expect(review.mock.calls[0]![1]).toEqual({ memories: [1], identities: {}, groups: [] })
})
it('keeps confirmation-only approval and disables a genuinely empty approval', async () => {
  proposal.memories = []
  await render()
  const approve = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Approve confirmations',
  )!
  expect(approve.disabled).toBe(false)
  await act(async () => approve.click())
  expect(review.mock.calls[0]![1]).toEqual({ memories: [], identities: {}, groups: [] })
  proposal = { ...proposal, revision: 1, confirmations: [] }
  await act(async () =>
    useBrain.setState({ status: { ...useBrain.getState().status!, revision: 1 } }),
  )
  expect(
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Approve 0')
      ?.disabled,
  ).toBe(true)
})

it('uses singular quotes and keeps the outcome on the sentence row without shrinking', async () => {
  await render()
  const row = container.querySelector('[aria-label="Proposed memories"] article')!
  const label = row.querySelector('label')!
  const tag = [...row.querySelectorAll('span')].find((s) => s.textContent === 'new')!
  expect(row.querySelector('summary')?.textContent).toBe('1 quote')
  expect(tag.parentElement).toBe(label.parentElement)
  expect(tag.classList.contains('shrink-0')).toBe(true)
  expect(label.classList.contains('flex-1')).toBe(true)
})
