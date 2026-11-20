// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainAgentRun } from '@shared/brain-agent'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { BrainStatusStrip } from './BrainStatusStrip'
import { openBrainSource } from './openBrainSource'
vi.mock('./openBrainSource', () => ({ openBrainSource: vi.fn(async () => undefined) }))
import { useBrain } from './useBrain'
import { mockBrainJob, mockBrainStatus } from './mockBrainData'

let root: Root, container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
const NOW = 1_793_966_400_000
const run = (patch: Partial<BrainAgentRun> = {}): BrainAgentRun => ({
  id: 'defrag-1',
  state: 'running',
  total: 31,
  decided: 12,
  erased: 2,
  undoable: 10,
  queuedAt: NOW - 300000,
  startedAt: NOW - 240000,
  finishedAt: null,
  error: null,
  sessionPath: null,
  rulesChanged: false,
  ...patch,
})
const stop = vi.fn(async () => mockBrainStatus())
const undo = vi.fn(async () => ({ ...mockBrainStatus(), undone: 10, kept: 2 }))
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(openBrainSource).mockReset().mockResolvedValue(undefined)
  stop.mockClear()
  undo.mockClear()
  fake = createFakePhosphor({ 'brain:defragStop': stop, 'brain:undoRun': undo })
  restore = installFakePhosphor(fake)
  useExtensionUiStore.setState({ toasts: [] })
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
  vi.unstubAllGlobals()
})
async function render(agentRun: BrainAgentRun, jobs = mockBrainStatus().jobs): Promise<void> {
  const status = mockBrainStatus()
  status.jobs = jobs
  status.agent.run = agentRun
  useBrain.setState({ status, saving: false, error: '' })
  await act(async () => root.render(<BrainStatusStrip onLanes={() => {}} />))
}
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
it('shows running progress, elapsed minutes, a disabled unavailable lane link and Stop', async () => {
  await render(run())
  expect(container.textContent).toContain('Brain Agent is defragging · 12 of 31 · 4 min')
  const lane = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Brain lane',
  )!
  expect(lane.disabled).toBe(true)
  expect(lane.dataset.tooltip).toContain('not available')
  await click('Stop')
  expect(stop).toHaveBeenCalledOnce()
})
it('queues behind the current read, or the reads already queued', async () => {
  await render(run({ state: 'queued' }), [
    mockBrainJob({ state: 'running', title: 'Harbor planning' }),
  ])
  expect(container.textContent).toContain(
    'Defrag starts after Brain finishes reading Harbor planning',
  )
  await render(run({ state: 'queued' }), [])
  expect(container.textContent).toContain('Defrag starts after the reads already queued')
})
it.each(['done', 'stopped', 'failed'] as const)(
  'shows the %s result and Undo run',
  async (state) => {
    await render(
      run({
        state,
        decided: 31,
        finishedAt: NOW - 540000,
        error: state === 'failed' ? 'Ledger unavailable' : null,
        rulesChanged: true,
      }),
    )
    expect(container.textContent).toContain(
      'Brain Agent decided 31 things and erased 2 · 9 min ago',
    )
    expect(container.textContent).toContain('Its rules changed during the run.')
    if (state === 'stopped') expect(container.textContent).toContain('stopped')
    if (state === 'failed') expect(container.textContent).toContain('Ledger unavailable')
    await click('Undo run')
    expect(undo).toHaveBeenCalledWith('defrag-1')
    expect(useExtensionUiStore.getState().toasts.at(-1)?.message).toBe(
      'Undid 10 changes. 2 stay: erasures, and changes later edits use.',
    )
  },
)
it('hides Undo run once no changes can be undone', async () => {
  await render(run({ state: 'done', undoable: 0 }))
  expect(container.textContent).not.toContain('Undo run')
})

it('opens the ordinary Brain lane and recovers a failed open on another click', async () => {
  await render(run({ sessionPath: '/demo/brain/Brain/lane.jsonl' }))
  vi.mocked(openBrainSource).mockRejectedValueOnce(new Error('Lane unavailable'))
  await click('Brain lane')
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Lane unavailable')
  await click('Brain lane')
  expect(openBrainSource).toHaveBeenLastCalledWith('/demo/brain/Brain/lane.jsonl')
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
it('keeps Stop retryable after a refusal', async () => {
  await render(run())
  stop.mockRejectedValueOnce(new Error('Stop unavailable'))
  await click('Stop')
  expect(container.textContent).toContain('Stop unavailable')
  await click('Stop')
  expect(stop).toHaveBeenCalledTimes(2)
})

it.each([
  [null, 'Brain Agent is defragging · 12 of 31'],
  [NOW + 60_000, 'Brain Agent is defragging · 12 of 31'],
  [NOW - 59_999, 'Brain Agent is defragging · 12 of 31'],
  [NOW - 60_000, 'Brain Agent is defragging · 12 of 31 · 1 min'],
  [NOW - 3_660_000, 'Brain Agent is defragging · 12 of 31 · 1 h 1 min'],
])('shows elapsed words only after a full minute (start %s)', async (startedAt, expected) => {
  await render(run({ startedAt }))
  expect(container.querySelector('span.flex-1')?.textContent).toBe(expected)
})

it('updates duration words when the first minute elapses', async () => {
  await render(run({ startedAt: NOW }))
  await act(async () => vi.advanceTimersByTime(60_000))
  expect(container.textContent).toContain('Brain Agent is defragging · 12 of 31 · 1 min')
})

it('uses singular changes and the singular verb in the Undo run toast', async () => {
  undo.mockResolvedValueOnce({ ...mockBrainStatus(), undone: 1, kept: 1 })
  await render(run({ state: 'done' }))
  await click('Undo run')
  expect(useExtensionUiStore.getState().toasts.at(-1)?.message).toBe(
    'Undid 1 change. 1 stays: erasures, and changes later edits use.',
  )
})
