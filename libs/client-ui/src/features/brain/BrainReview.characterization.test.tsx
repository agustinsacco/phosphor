// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { BrainReview } from './BrainReview'
import { mockBrainProposal, mockBrainStatus } from './mockBrainData'
import { useBrain } from './useBrain'

it('preserves explicit identity overrides, group choices and memory indexes in the review decision', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const proposal = mockBrainProposal()
  for (const identity of proposal.identities)
    identity.candidates.push({
      ...identity.candidates[0]!,
      id: `${identity.ref}-other`,
      label: 'Kestrel',
    })
  const status = { ...mockBrainStatus(), jobs: [proposal.job] }
  const review = vi.fn().mockResolvedValue(status)
  const fake = createFakePhosphor({ 'brain:proposal': () => proposal, 'brain:review': review })
  const restore = installFakePhosphor(fake)
  useBrain.setState({ status, error: '', saving: false })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <BrainReview jobId={proposal.job.id} onClose={() => {}} onExtraction={() => {}} />,
      ),
    )
    for (const [label, value] of [
      ['Harbor', 'new'],
      ['Harbor Ledger', 'ledger-other'],
      ['Rina Okafor', 'rina'],
      ['Tom Lee', 'new'],
    ]) {
      const picker = container.querySelector<HTMLSelectElement>(
        `[aria-label="Identity for ${label}"]`,
      )!
      await act(async () => {
        picker.value = value!
        picker.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    await act(async () =>
      container.querySelector<HTMLInputElement>('[aria-label="Possible groups"] input')!.click(),
    )
    const memory = [
      ...container.querySelectorAll<HTMLLabelElement>('[aria-label="Proposed memories"] label'),
    ].find((label) => label.textContent === proposal.memories[0]!.summary)!
    await act(async () => memory.querySelector<HTMLInputElement>('input')!.click())
    const approve = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Approve 1',
    )!
    await act(async () => approve.click())
    expect(review).toHaveBeenCalledWith(
      'harbor-job',
      {
        memories: [1],
        identities: { harbor: 'new', ledger: 'ledger-other', rina: 'rina', tom: 'new' },
        groups: [0],
      },
      0,
    )
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
    vi.unstubAllGlobals()
  }
})
