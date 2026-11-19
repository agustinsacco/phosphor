// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainExtractionView, BrainHistory, BrainStatus } from '@shared/brain'
import type { BrainTidyChanges } from '@shared/brain-tidy'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { PromptHost } from '@/components/PromptHost'
import { mockBrainJob, mockBrainStatus } from '../mockBrainData'
import { mockExtractionView } from '../mockExtractionView'
import { useBrain } from '../useBrain'
import { BrainLanes } from './BrainLanes'
import type { LaneSelection } from './laneGroups'

let root: Root, container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
let status: BrainStatus
let selection: LaneSelection | null
const NOW = 1_793_966_400_000
const history = vi.fn<(limit: number) => Promise<BrainHistory>>()
const extraction = vi.fn<(id: string) => Promise<BrainExtractionView>>()
const changes = vi.fn<(limit: number) => Promise<BrainTidyChanges>>()
const undo = vi.fn<(id: string, revision: number) => Promise<BrainStatus>>()
const cancel = vi.fn<(id: string) => Promise<BrainStatus>>()
const retry = vi.fn<(id: string) => Promise<BrainStatus>>()
const queue = vi.fn<(lane: { sessionPath: string; title: string }) => Promise<BrainStatus>>()
const reread = vi.fn<(id: string) => Promise<BrainStatus>>()
const tidy = { page: null, error: '', loading: false, reload: vi.fn(async () => null) }

function Harness({ initial }: { initial: LaneSelection | null }): React.JSX.Element {
  const [current, setCurrent] = useState(initial)
  selection = current
  return (
    <>
      <BrainLanes tidy={tidy} selected={current} onSelect={setCurrent} onMemory={() => {}} />
      <PromptHost />
    </>
  )
}
const finished = mockBrainJob({ id: 'harbor-read', state: 'done', finishedAt: NOW - 2 * 3_600_000 })
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  status = mockBrainStatus()
  useBrain.setState({ status, saving: false, error: '' })
  useModelCatalogueStore.setState({
    models: [{ provider: 'demo', id: 'harbor-model', name: 'Harbor Reader', reasoning: true }],
  })
  history.mockReset().mockResolvedValue({
    items: [{ job: finished, memories: 3, replaceable: 2 }],
    more: false,
  })
  extraction.mockReset().mockImplementation(async (id) => ({
    ...mockExtractionView(),
    jobId: id,
    job: id === 'harbor-read' ? finished : mockBrainJob({ id }),
    laneMemories: 3,
    replaceable: 2,
  }))
  changes.mockReset().mockResolvedValue({
    items: [
      {
        id: 'op-1',
        kind: 'merge',
        automatic: false,
        summary: 'Merged Rina into Rina Okafor',
        createdAt: NOW - 60_000,
        undoneAt: null,
        suggestionId: null,
      },
    ],
    revision: 0,
  })
  for (const fn of [undo, cancel, retry, queue, reread])
    fn.mockReset().mockImplementation(async () => status)
  fake = createFakePhosphor({
    'brain:history': history,
    'brain:extraction': extraction,
    'brain:tidyChanges': changes,
    'brain:tidyUndo': undo,
    'brain:cancel': cancel,
    'brain:retry': retry,
    'brain:queue': queue,
    'brain:reread': reread,
  })
  restore = installFakePhosphor(fake)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  useModelCatalogueStore.setState({ models: [] })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function render(jobs = status.jobs, initial: LaneSelection | null = null): Promise<void> {
  status = { ...status, jobs }
  useBrain.setState({ status })
  await act(async () => root.render(<Harness initial={initial} />))
}
const section = (name: string): HTMLElement => container.querySelector(`[aria-label="${name}"]`)!
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

it('lists reads by state and Recent changes, and opens the first read in progress', async () => {
  await render([
    mockBrainJob({ id: 'running', state: 'running', startedAt: NOW - 3 * 60_000, progress: null }),
    mockBrainJob({ id: 'queued', state: 'queued', queuedAt: NOW - 2 * 3_600_000 }),
    mockBrainJob({ id: 'review', state: 'review' }),
  ])
  const list = section('Brain lanes')
  expect([...list.querySelectorAll('section')].map((s) => s.ariaLabel)).toEqual([
    'Reading',
    'Queued',
    'Read',
    'Recent changes',
  ])
  expect(section('Reading').textContent).toContain('Reading · 3 min')
  expect(section('Queued').textContent).toContain('Queued 2 h ago · 1 ahead')
  expect(section('Read').textContent).toContain('3 memories · 2 h ago')
  expect(list.textContent).not.toContain('review')
  expect(selection).toEqual({ type: 'job', id: 'running' })
})

it('shows a running read with its steps, honest time, Cancel and recoverable calls', async () => {
  const job = mockBrainJob({
    state: 'running',
    startedAt: NOW - 72_000,
    progress: { stage: 'extract', done: 2, total: 3 },
  })
  extraction.mockRejectedValueOnce(new Error('Calls unavailable'))
  await render([job])
  const detail = section('Lane detail')
  expect(detail.textContent).toContain('Harbor Reader · Reading for 1 min')
  expect(detail.querySelector('[aria-current="step"]')?.textContent).toContain(
    'Read the conversation · part 2 of 3',
  )
  expect(detail.textContent).toContain('Calls unavailable')
  await click('Retry', detail)
  expect(detail.querySelectorAll('details[open]')).toHaveLength(0)
  await click('Cancel', detail)
  expect(cancel).toHaveBeenCalledWith(job.id)
})

it('shows a queued read without a started call or a done step', async () => {
  await render([mockBrainJob({ state: 'queued', startedAt: null, queuedAt: NOW - 30_000 })])
  expect(section('Lane detail').textContent).toContain('Queued just now')
  expect(extraction).not.toHaveBeenCalled()
  expect(section('Lane detail').querySelectorAll('[aria-label="Done"]')).toHaveLength(0)
})

it('shows the whole failed error with Retry and Dismiss', async () => {
  const job = mockBrainJob({ state: 'failed', error: 'Kestrel failed. '.repeat(30) })
  await render([job])
  expect(section('Lane detail').querySelector('[role="alert"]')?.textContent).toBe(job.error)
  await click('Retry', section('Lane detail'))
  expect(retry).toHaveBeenCalledWith(job.id)
  await click('Dismiss', section('Lane detail'))
  expect(cancel).toHaveBeenCalledWith(job.id)
})

it('treats a read with no saved call yet as empty, without a toast', async () => {
  const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast')
  extraction.mockRejectedValueOnce(
    new Error(
      "Error invoking remote method 'brain:extraction': Error: Brain extraction not found (dismissed or expired).",
    ),
  )
  await render([
    mockBrainJob({ state: 'running', progress: { stage: 'extract', done: 0, total: 1 } }),
  ])
  expect(section('Lane detail').textContent).toContain('No calls yet.')
  expect(toast).not.toHaveBeenCalled()
  toast.mockRestore()
})

it('says what a finished read kept and offers each way to read the lane again', async () => {
  const view = mockExtractionView()
  extraction.mockResolvedValue({
    ...view,
    job: finished,
    jobId: finished.id,
    laneMemories: 3,
    replaceable: 2,
    source: { ...view.source, exists: true },
  })
  await render([], { type: 'job', id: 'harbor-read' })
  const detail = section('Read detail')
  expect(detail.textContent).toContain('took less than a minute')
  expect([...detail.querySelectorAll('dd')].map((dd) => dd.textContent)).toHaveLength(3)
  expect(detail.textContent).toContain('Covered: Whole lane')
  await click('Read new messages', detail)
  expect(queue).toHaveBeenCalledWith({ sessionPath: finished.sessionPath, title: finished.title })
  await click('Read again', detail)
  expect(document.body.textContent).toContain('Brain reads the whole lane again.')
  expect(reread).not.toHaveBeenCalled()
})

it('keeps an empty read dismissible and never offers to read it again', async () => {
  const empty = mockBrainJob({ id: 'empty', state: 'empty', finishedAt: NOW })
  extraction.mockResolvedValue({ ...mockExtractionView(), job: empty, jobId: 'empty' })
  await render([empty], { type: 'job', id: 'empty' })
  expect(section('Read').textContent).toContain('Nothing worth keeping')
  expect(button('Read again')).toBeUndefined()
  await click('Dismiss', section('Read detail'))
  expect(cancel).toHaveBeenCalledWith('empty')
})

it('recovers a failed first history load with Retry', async () => {
  history.mockRejectedValueOnce(new Error('History unavailable'))
  await render([])
  expect(section('Brain lanes').textContent).toContain('History unavailable')
  await click('Retry', section('Brain lanes'))
  expect(section('Read').textContent).toContain('3 memories')
})

it('undoes a change from its row or its detail, and shows a refused Undo in words', async () => {
  await render([], { type: 'change', id: null })
  expect(selection).toEqual({ type: 'change', id: 'op-1' })
  expect(section('Change detail').textContent).toContain('Combined names, links and memories.')
  undo.mockRejectedValueOnce(new Error('Later changes prevent a clean undo.'))
  await click('Undo', section('Change detail'))
  expect(undo).toHaveBeenCalledWith('op-1', 0)
  expect(section('Change detail').querySelector('[role="alert"]')?.textContent).toBe(
    'Later changes prevent a clean undo.',
  )
  await click('Undo', section('Recent changes'))
  expect(undo).toHaveBeenCalledTimes(2)
})

it('shows a read older than the newest 200 without inventing a row for it', async () => {
  await render([], { type: 'job', id: 'old-read' })
  expect(extraction).toHaveBeenCalledWith('old-read')
  expect(section('Read detail')).not.toBeNull()
  expect(section('Brain lanes').querySelector('[aria-current]')).toBeNull()
})

it('moves on when the open read is cancelled', async () => {
  const queued = mockBrainJob({ id: 'queued', state: 'queued' })
  await render([queued], { type: 'job', id: 'queued' })
  await click('Cancel', section('Lane detail'))
  await act(async () => useBrain.setState({ status: { ...status, jobs: [] } }))
  expect(selection).toEqual({ type: 'job', id: 'harbor-read' })
})

it('says a rejected read saved nothing, and offers none of its memories', async () => {
  const rejected = mockBrainJob({ id: 'rejected', state: 'rejected', finishedAt: NOW - 60_000 })
  extraction.mockResolvedValue({ ...mockExtractionView(), job: rejected, jobId: 'rejected' })
  await render([rejected], { type: 'job', id: 'rejected' })
  expect(section('Read').textContent).toContain('Rejected')
  const detail = section('Read detail')
  expect(detail.textContent).toContain('Rejected · nothing was saved')
  expect(detail.querySelectorAll('dd')).toHaveLength(0)
  expect(detail.textContent).not.toContain('See these memories')
  expect(button('Read again', detail)).toBeUndefined()
})

it('times a resumed read from its current attempt', async () => {
  await render([
    mockBrainJob({
      state: 'running',
      startedAt: NOW - 5 * 3_600_000,
      runStartedAt: NOW - 3 * 60_000,
      progress: null,
    }),
  ])
  expect(section('Reading').textContent).toContain('Reading · 3 min')
  expect(section('Lane detail').textContent).toContain('Reading for 3 min')
  expect(section('Lane detail').textContent).not.toContain('5 h')
})

it('shows a refreshing review apart, with honest time and no Cancel', async () => {
  await render([
    mockBrainJob({
      id: 'refreshing',
      state: 'refreshing',
      startedAt: NOW - 5 * 3_600_000,
      runStartedAt: NOW - 2 * 60_000,
    }),
  ])
  expect(section('Refreshing')).not.toBeNull()
  expect(section('Refreshing').textContent).toContain('Refreshing for 2 min')
  const detail = section('Lane detail')
  expect(detail.textContent).toContain('Refreshing for 2 min')
  expect(detail.textContent).toContain('Brain changed since this lane was read')
  expect(button('Cancel', detail)).toBeUndefined()
})
