// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { BrainLaneDetail } from './BrainLaneDetail'
import { mockBrainJob, mockBrainStatus } from './mockBrainData'
import { mockExtractionView } from './mockExtractionView'
import { useBrain } from './useBrain'
import { useExtensionUiStore } from '@/stores/extensionUi'

let root: Root
let container: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
const extraction = vi.fn()
const cancel = vi.fn()
const retry = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const status = mockBrainStatus()
  useBrain.setState({ status, saving: false, error: '' })
  useModelCatalogueStore.setState({
    models: [{ provider: 'demo', id: 'harbor-model', name: 'Harbor Reader', reasoning: true }],
  })
  extraction.mockReset().mockResolvedValue(mockExtractionView())
  cancel.mockReset().mockResolvedValue(status)
  retry.mockReset().mockResolvedValue(status)
  fake = createFakePhosphor({
    'brain:extraction': extraction,
    'brain:cancel': cancel,
    'brain:retry': retry,
  })
  restore = installFakePhosphor(fake)
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  restore()
  fake.dispose()
  useModelCatalogueStore.setState({ models: [] })
  vi.unstubAllGlobals()
})
async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  )!
  await act(async () => button.click())
}
it('shows reported progress only, human model name, cancel, collapsed calls and recovery', async () => {
  const job = mockBrainJob({ state: 'running', progress: { stage: 'extract', done: 2, total: 3 } })
  extraction.mockRejectedValueOnce(new Error('Calls unavailable'))
  await act(async () =>
    root.render(
      <BrainLaneDetail
        jobId={job.id}
        job={job}
        readOnly={false}
        now={job.startedAt! + 72000}
        onMemory={() => {}}
      />,
    ),
  )
  expect(container.textContent).toContain('Harbor Reader · started 1:12 ago')
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
    'Read the conversation · part 2 of 3',
  )
  expect(container.querySelectorAll('[aria-label="Done"]')).toHaveLength(1)
  expect(container.querySelectorAll('[aria-label="Pending"]')).toHaveLength(3)
  expect(container.textContent).toContain('Calls unavailable')
  await click('Retry')
  expect(container.querySelectorAll('[aria-label="How it was read"] details')).toHaveLength(3)
  expect(container.querySelectorAll('details[open]')).toHaveLength(0)
  await click('Cancel')
  expect(cancel).toHaveBeenCalledWith(job.id)
})
it.each(['queued', 'waiting'] as const)(
  'shows %s without inventing a started call or done step',
  async (state) => {
    const job = mockBrainJob({ state, startedAt: null })
    await act(async () =>
      root.render(
        <BrainLaneDetail jobId={job.id} job={job} readOnly={false} now={0} onMemory={() => {}} />,
      ),
    )
    expect(container.textContent).toContain(
      state === 'queued' ? 'Queued · starting' : 'Waits until the lane is idle',
    )
    expect(extraction).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[aria-label="Done"]')).toHaveLength(0)
  },
)
it('shows the full failed error and offers Retry and Dismiss', async () => {
  const job = mockBrainJob({ state: 'failed', error: 'Kestrel failed. '.repeat(30) })
  await act(async () =>
    root.render(
      <BrainLaneDetail jobId={job.id} job={job} readOnly={false} now={0} onMemory={() => {}} />,
    ),
  )
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(job.error)
  await click('Retry')
  expect(retry).toHaveBeenCalledWith(job.id)
  await click('Dismiss')
  expect(cancel).toHaveBeenCalledWith(job.id)
})
it('keeps empty reads dismissible without Read again', async () => {
  const job = mockBrainJob({ state: 'empty' })
  extraction.mockResolvedValue({ ...mockExtractionView(), job })
  await act(async () =>
    root.render(
      <BrainLaneDetail jobId={job.id} job={job} readOnly={false} now={0} onMemory={() => {}} />,
    ),
  )
  expect(container.textContent).not.toContain('Read again')
  await click('Dismiss')
  expect(cancel).toHaveBeenCalledWith(job.id)
})

it.each(['failed', 'running'] as const)(
  'keeps outcomes and source inspection for a %s record',
  async (state) => {
    const job = mockBrainJob({ state })
    const data = mockExtractionView()
    data.source.exists = true
    extraction.mockResolvedValue(data)
    await act(async () =>
      root.render(
        <BrainLaneDetail jobId={job.id} job={job} readOnly={false} now={0} onMemory={() => {}} />,
      ),
    )
    expect(container.querySelector('[aria-label="Read result"]')?.textContent).toContain(
      'Link quote not found in s2',
    )
    expect(container.textContent).toContain('Source lane at extraction')
    expect(container.textContent).toContain('Open lane')
  },
)

it('treats a not-yet-recorded read as empty without notifying and loads it on progress', async () => {
  const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast')
  const job = mockBrainJob({ state: 'running', progress: { stage: 'extract', done: 0, total: 1 } })
  extraction.mockRejectedValueOnce(
    new Error(
      "Error invoking remote method 'brain:extraction': Error: Brain extraction not found (dismissed or expired).",
    ),
  )
  const render = () =>
    act(async () =>
      root.render(
        <BrainLaneDetail jobId={job.id} job={job} readOnly={false} now={0} onMemory={() => {}} />,
      ),
    )
  try {
    await render()
    expect(container.textContent).toContain('No calls yet.')
    expect(toast).not.toHaveBeenCalled()
    job.progress = { stage: 'identity', done: 0, total: 1 }
    await render()
    expect(container.querySelector('[aria-label="How it was read"]')).not.toBeNull()
    expect(toast).not.toHaveBeenCalled()
  } finally {
    toast.mockRestore()
  }
})
