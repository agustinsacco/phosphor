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
import { mockExtractionView } from './mockExtractionView'

afterEach(() => vi.unstubAllGlobals())

it('shows per-call answers, rebuilt prompts, trace fallback and rejected-link reasons after retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const job = mockBrainJob()
  const view = mockExtractionView()
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
    expect(container.querySelectorAll('details[open]')).toHaveLength(0)
    for (const detail of container.querySelectorAll<HTMLDetailsElement>(
      '[aria-label="How it was read"] details',
    ))
      await act(async () => {
        detail.open = true
        detail.dispatchEvent(new Event('toggle'))
      })
    expect(container.textContent).toContain('Read the conversation · part 1')
    expect(container.textContent).toContain('Find relationships · part 1')
    expect(container.textContent).toContain('Find relationships in the kept claims.')
    expect(container.textContent).toContain('Compare with what Brain knows · part 1')
    expect(container.textContent).toContain('Read the invented Harbor window.')
    expect(container.textContent).toContain('Compare the invented claims.')
    expect(container.textContent).toContain('Link quote not found in s2')
    expect(container.textContent).toContain('Source lane is no longer available')
    expect(container.querySelector('pre')!.textContent).toBe('{\n  "claims": []\n}')
    const memory = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Harbor decision',
    )!
    await act(async () => memory.click())
    expect(onMemory).toHaveBeenCalledWith('memory-1', 'Harbor decision')
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})
it('prints conversation and matching progress in the inbox', () => {
  expect(
    jobLine(
      mockBrainJob({ state: 'running', progress: { stage: 'extract', done: 3, total: 12 } }),
      0,
      0,
    ),
  ).toBe('Read the conversation · part 3 of 12')
  expect(
    jobLine(
      mockBrainJob({ state: 'running', progress: { stage: 'identity', done: 1, total: 2 } }),
      0,
      0,
    ),
  ).toBe('Match people and things · part 1 of 2')
})
it('includes the conversation part even for a single-part stage', () => {
  for (const done of [0, 1])
    expect(
      jobLine(
        mockBrainJob({ state: 'running', progress: { stage: 'extract', done, total: 1 } }),
        0,
        0,
      ),
    ).toBe('Read the conversation · part 1 of 1')
})

it('renders forgotten outcomes as removed, and offers Read again in a finished read header', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const data = mockExtractionView()
  data.job = mockBrainJob({ state: 'done' })
  data.laneMemories = 2
  data.replaceable = 2
  data.memories = []
  data.outcomes[1]!.removed = true
  const fake = createFakePhosphor({ 'brain:extraction': async () => data })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<BrainExtraction jobId={data.jobId} onMemory={() => {}} onBack={() => {}} />),
    )
    expect(container.textContent).toContain('removed')
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'Harbor decision'),
    ).toBe(false)
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'Read again'),
    ).toBe(true)
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})

it('puts only nonzero outcomes first, pages at twenty, and leaves model calls closed', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const data = mockExtractionView()
  data.outcomes = Array.from({ length: 24 }, (_, index) => ({
    candidate: `c${index}`,
    summary: `Harbor claim ${index}`,
    status: 'kept',
  }))
  const fake = createFakePhosphor({ 'brain:extraction': () => data })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<BrainExtraction jobId={data.jobId} onMemory={() => {}} />))
    const result = container.querySelector('[aria-label="Read result"]')!
    expect(result.textContent).toContain('Result · 24 kept')
    expect(result.textContent).not.toContain('0 dropped')
    expect(result.querySelectorAll('li')).toHaveLength(20)
    expect(container.querySelectorAll('pre')).toHaveLength(0)
    const more = [...result.querySelectorAll('button')].find(
      (button) => button.textContent === 'Show more',
    )!
    await act(async () => more.click())
    expect(result.querySelectorAll('li')).toHaveLength(24)
    expect(container.textContent).not.toMatch(/tokens|cost|demo\//)
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})
