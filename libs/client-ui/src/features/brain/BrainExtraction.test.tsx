// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainExtractionView } from '@shared/brain'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { BrainExtraction } from './BrainExtraction'
import { mockBrainJob } from './mockBrainData'
import { jobLine } from './BrainInbox'

afterEach(() => vi.unstubAllGlobals())
function extractionView(): BrainExtractionView {
  const job = mockBrainJob()
  return {
    jobId: job.id,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: job.leafId,
    model: job.model,
    thinking: 'low',
    startedAt: 0,
    finishedAt: 5000,
    calls: [
      {
        stage: 'extract',
        part: 1,
        entryIds: ['entry-1'],
        inputHash: 'invented',
        answer: '{ "claims": [] }',
        trace: null,
        error: null,
      },
      {
        stage: 'reconcile',
        part: 1,
        entryIds: [],
        inputHash: 'another',
        answer: 'No old claims',
        trace: null,
        error: null,
      },
    ],
    prompts: ['Read the invented Harbor window.', 'Compare the invented claims.'],
    outcomes: [
      {
        candidate: 'w1:c2',
        summary: 'Rejected owner link',
        status: 'dropped',
        reason: 'Link quote not found in s2',
      },
      { candidate: 'w1:c1', summary: 'Harbor decision', status: 'kept', memoryId: 'memory-1' },
    ],
    memories: [{ id: 'memory-1', summary: 'Harbor decision' }],
    error: null,
    source: {
      sessionPath: job.sessionPath,
      title: job.title,
      leafId: job.leafId,
      exists: false,
      segments: [],
    },
  }
}

it('shows per-call answers, rebuilt prompts, trace fallback and rejected-link reasons after retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const job = mockBrainJob()
  const view = extractionView()
  const extraction = vi
    .fn<() => Promise<BrainExtractionView>>()
    .mockRejectedValueOnce(new Error('Harbor record unavailable'))
    .mockResolvedValue(view)
  const fake = createFakePhosphor({ 'brain:extraction': extraction })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  const onMemory = vi.fn(),
    onBack = vi.fn()
  try {
    await act(async () =>
      root.render(<BrainExtraction jobId={job.id} onMemory={onMemory} onBack={onBack} />),
    )
    expect(container.textContent).toContain('Harbor record unavailable')
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
    await act(async () => retry.click())
    expect(container.textContent).toContain('extract · part 1')
    expect(container.textContent).toContain('reconcile · part 1')
    expect(container.textContent).toContain('Read the invented Harbor window.')
    expect(container.textContent).toContain('Compare the invented claims.')
    expect(container.textContent).toContain('Link quote not found in s2')
    expect(container.textContent).toContain('Source lane is no longer available')
    expect(container.querySelector('pre')!.textContent).toBe('{\n  "claims": []\n}')
    const memory = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Harbor decision',
    )!
    await act(async () => memory.click())
    expect(onMemory).toHaveBeenCalledWith('memory-1')
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})
it('prints window and matching progress in the inbox', () => {
  expect(
    jobLine(
      mockBrainJob({ state: 'running', progress: { stage: 'extract', done: 3, total: 12 } }),
      0,
      0,
    ),
  ).toBe('Reading window 3 of 12')
  expect(
    jobLine(
      mockBrainJob({ state: 'running', progress: { stage: 'identity', done: 1, total: 2 } }),
      0,
      0,
    ),
  ).toBe('Matching entities 1 of 2')
})
