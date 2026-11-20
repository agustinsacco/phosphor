// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  BrainExtractionView,
  BrainHistory,
  BrainStatus,
  BrainProposalView,
} from '@shared/brain'
import { BRAIN_REVIEW_REFRESHING } from '@shared/brain-review'
import type { BrainTidyChanges } from '@shared/brain-tidy'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { PromptHost } from '@/components/PromptHost'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { mockBrainJob, mockBrainStatus, mockBrainProposal } from '../mockBrainData'
import { mockCallTrace, mockExtractionView } from '../mockExtractionView'
import { useBrain } from '../useBrain'
import { BrainLanes } from './BrainLanes'
import type { LaneSelection } from './laneGroups'

let root: Root, container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
let status: BrainStatus
let selection: LaneSelection | null
const NOW = 1_793_966_400_000
const proposal = vi.fn<() => Promise<BrainProposalView>>()
const history = vi.fn<(limit: number) => Promise<BrainHistory>>()
const extraction = vi.fn<(id: string) => Promise<BrainExtractionView>>()
const changes = vi.fn<(limit: number) => Promise<BrainTidyChanges>>()
const undo = vi.fn<(id: string, revision: number) => Promise<BrainStatus>>()
const cancel = vi.fn<(id: string) => Promise<BrainStatus>>()
const retry = vi.fn<(id: string) => Promise<BrainStatus>>()
const queue = vi.fn<(lane: { sessionPath: string; title: string }) => Promise<BrainStatus>>()
const reread = vi.fn<(id: string) => Promise<BrainStatus>>()

function Harness({ initial }: { initial: LaneSelection | null }): React.JSX.Element {
  const [current, setCurrent] = useState(initial)
  selection = current
  return (
    <>
      <BrainLanes selected={current} onSelect={setCurrent} onMemory={() => {}} />
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
        who: 'you',
        reason: null,
        runId: null,
        jobId: null,
        undoable: true,
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
  proposal
    .mockReset()
    .mockImplementation(async () =>
      mockBrainProposal(status.jobs.find((job) => job.state === 'review')),
    )
  fake = createFakePhosphor({
    'brain:history': history,
    'brain:extraction': extraction,
    'brain:proposal': proposal,
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
    'Waiting for Defrag',
    'Reading',
    'Queued',
    'Read',
    'Recent changes',
    'Never read',
  ])
  expect(section('Reading').textContent).toContain('Reading · 3 min')
  expect(section('Queued').textContent).toContain('Queued 2 h ago · 1 ahead')
  expect(section('Read').textContent).toContain('3 memories from this read · 2 h ago')
  expect(section('Waiting for Defrag').textContent).toContain('2 memories')
  expect(selection).toEqual({ type: 'job', id: 'review' })
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
    // Its review refreshed two days later; the model spent 1 min on its three calls.
    finishedAt: view.startedAt + 2 * 86_400_000,
    calls: view.calls.map((call) => ({ ...call, trace: mockCallTrace(20_000) })),
  })
  await render([], { type: 'job', id: 'harbor-read' })
  const detail = section('Read detail')
  expect(detail.textContent).toContain('took 1 min')
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
  expect(section('Waiting for Defrag')).not.toBeNull()
  expect(section('Waiting for Defrag').textContent).toContain('Refreshing for 2 min')
  const detail = section('Lane detail')
  expect(detail.textContent).toContain('Waits for Defrag')
  expect(detail.textContent).toContain('Brain changed since this lane was read')
  expect(button('Cancel', detail)).toBeUndefined()
})

const when = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

it('says a read covered the new messages after the read it continues', async () => {
  const previous = mockBrainJob({
    id: 'previous',
    state: 'done',
    leafId: 'leaf-7',
    finishedAt: NOW - 86_400_000,
  })
  const latest = mockBrainJob({
    id: 'latest',
    state: 'done',
    fromLeafId: 'leaf-7',
    finishedAt: NOW,
  })
  // Two reads of one lane: each row counts what that read kept; replaceable is lane-wide.
  history.mockResolvedValue({
    items: [
      { job: latest, memories: 2, replaceable: 3 },
      { job: previous, memories: 1, replaceable: 3 },
    ],
    more: false,
  })
  extraction.mockImplementation(async (id) => ({
    ...mockExtractionView(),
    jobId: id,
    job: id === 'latest' ? latest : previous,
  }))
  await render([], { type: 'job', id: 'latest' })
  expect([...section('Read').querySelectorAll('li')].map((row) => row.textContent)).toEqual([
    'Harbor planning2 memories from this read · just now',
    'Harbor planning1 memory from this read · 1 day ago',
  ])
  expect(section('Read detail').textContent).toContain(
    `Covered: New messages after ${when(previous.finishedAt!)}`,
  )
})

it('falls back to the previous read when the one a read continues is gone', async () => {
  const latest = mockBrainJob({ id: 'latest', state: 'done', fromLeafId: 'leaf-gone' })
  extraction.mockResolvedValue({ ...mockExtractionView(), jobId: 'latest', job: latest })
  await render([], { type: 'job', id: 'latest' })
  expect(section('Read detail').textContent).toContain(
    'Covered: New messages since the previous read',
  )
})

it('lists the lanes Brain never reads, and sends the owner to Settings to change them', async () => {
  useSettingsUiStore.setState({ open: false, tab: 'appearance' })
  status = {
    ...status,
    prefs: { ...status.prefs, neverRead: { titles: ['1:1', 'standup'], sessionIds: ['a', 'b'] } },
  }
  await render([])
  const never = section('Never read')
  expect(never).not.toBeNull()
  expect(never.textContent).toContain('2 title patterns · 2 lanes switched off')
  await act(async () => never.querySelector('button')!.click())
  expect(selection).toEqual({ type: 'never' })
  const detail = section('Never read detail')
  expect(detail.textContent).toContain('“1:1”')
  expect(detail.textContent).toContain('“standup”')
  expect(detail.textContent).toContain('2 lanes switched off one by one')
  await click('Change in Settings', detail)
  expect(useSettingsUiStore.getState()).toMatchObject({ open: true, tab: 'brain' })
})

it('inspects a waiting read without manual decisions, and retries a failed proposal load', async () => {
  proposal.mockRejectedValueOnce(new Error('Read unavailable'))
  await render([mockBrainJob({ state: 'review' })])
  expect(section('Waiting read').textContent).toContain('Read unavailable')
  await click('Retry', section('Waiting read'))
  expect(section('Waiting read').textContent).toContain(
    'Waits for Defrag · 2 memories · 2 questions',
  )
  expect(section('Waiting read').textContent).toContain(
    'Brain Agent reviews this read in the next Defrag.',
  )
  expect(container.querySelector('input')).toBeNull()
  expect(button('Approve')).toBeUndefined()
  await click('See how it was read')
  expect(section('Read detail')).not.toBeNull()
})
it('explains that Brain Agent rejects a never-read waiting read', async () => {
  const job = mockBrainJob({ title: 'Harbor 1:1' })
  await render([job])
  expect(section('Waiting for Defrag').textContent).toContain('Brain never reads this lane')
  expect(section('Waiting read').textContent).toContain('Brain Agent will reject this read')
})
it('collapses long waiting groups without dropping the count', async () => {
  await render(Array.from({ length: 6 }, (_, i) => mockBrainJob({ id: `review-${i}` })))
  expect(section('Waiting for Defrag').querySelectorAll('li')).toHaveLength(3)
  await click('3 more')
  expect(section('Waiting for Defrag').querySelectorAll('li')).toHaveLength(6)
})
it('shows agent reasons, erasure finality, and the read behind an approval', async () => {
  const base = (await changes(50)).items[0]!
  changes.mockResolvedValue({
    revision: 1,
    items: [
      {
        ...base,
        id: 'erase',
        kind: 'erase',
        who: 'agent',
        undoable: false,
        reason: 'This fact is outdated.',
        summary: 'Erased a memory: This fact is outdated.',
      },
      {
        ...base,
        id: 'approve',
        kind: 'approve',
        who: 'agent',
        jobId: 'harbor-read',
        reason: 'The evidence supports these facts.',
      },
    ],
  })
  await render([], { type: 'change', id: 'erase' })
  expect(section('Change detail').textContent).toContain('This fact is outdated.')
  expect(section('Change detail').textContent).toContain('Erasing can’t be undone.')
  expect(button('Undo', section('Change detail'))).toBeUndefined()
  expect(section('Recent changes').textContent).toContain('can’t be undone')
  await act(async () =>
    [...section('Recent changes').querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Merged Rina'))!
      .click(),
  )
  await click('See the read', section('Change detail'))
  expect(selection).toEqual({ type: 'job', id: 'harbor-read' })
})

it('never uses an erased memory’s old summary in a row or its detail', async () => {
  const base = (await changes(50)).items[0]!
  changes.mockResolvedValue({
    revision: 1,
    items: [
      {
        ...base,
        id: 'erase-redacted',
        kind: 'erase',
        undoable: false,
        summary: 'OUTDATED MEMORY TEXT',
        reason: 'The owner corrected this.',
      },
    ],
  })
  await render([], { type: 'change', id: 'erase-redacted' })
  expect(container.textContent).not.toContain('OUTDATED MEMORY TEXT')
  expect(section('Recent changes').textContent).toContain(
    'Erased a memory: The owner corrected this.',
  )
})

it('loads stored memories even while the waiting read is refreshing', async () => {
  const job = mockBrainJob({ state: 'refreshing', runStartedAt: NOW - 60_000 })
  const stored = mockBrainProposal(job)
  proposal.mockResolvedValue(stored)
  await render([job])
  expect(section('Waiting read').textContent).toContain('Refreshing: Brain changed')
  expect(section('Waiting read').textContent).toContain(stored.memories[0]!.summary)
  expect(proposal).toHaveBeenCalledWith(job.id)
  expect(button('Retry', section('Waiting read'))).toBeUndefined()
})

it('treats a legacy refreshing proposal refusal as progress, never a failure or toast', async () => {
  const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast')
  proposal.mockRejectedValueOnce(new Error(BRAIN_REVIEW_REFRESHING))
  await render([mockBrainJob()])
  expect(section('Waiting read').textContent).toContain('Refreshing: Brain changed')
  expect(button('Retry', section('Waiting read'))).toBeUndefined()
  expect(toast).not.toHaveBeenCalled()
  toast.mockRestore()
})

it('uses the waiting row’s relative read time in its detail, including old reads', async () => {
  await render([mockBrainJob({ finishedAt: NOW - 14 * 86_400_000 })])
  expect(section('Waiting for Defrag').textContent).toContain('read 14 days ago')
  expect(section('Waiting read').textContent).toContain('read 14 days ago')
})

it('uses singular memory wording for a never-read waiting row', async () => {
  await render([mockBrainJob({ title: 'Harbor 1:1', memories: 1 })])
  expect(section('Waiting for Defrag').textContent).toContain(
    '1 memory · Brain never reads this lane',
  )
})
