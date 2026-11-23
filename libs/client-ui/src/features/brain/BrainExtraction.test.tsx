// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainExtractionView } from '@shared/brain'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { ReadDetail } from './lanes/ReadDetail'
import { mockBrainJob } from './mockBrainData'
import { callDuration, progressLine } from './jobProgress'
import { mockCallTrace, mockExtractionView } from './mockExtractionView'

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
  const onMemory = vi.fn()
  try {
    await act(async () =>
      root.render(<ReadDetail jobId={job.id} onMemory={onMemory} history={null} />),
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
it('names the step and part of a running read', () => {
  expect(progressLine({ stage: 'extract', done: 3, total: 12 })).toBe(
    'Read the conversation · part 3 of 12',
  )
  expect(progressLine({ stage: 'identity', done: 1, total: 2 })).toBe(
    'Match people and things · part 1 of 2',
  )
  expect(progressLine({ stage: 'reconcile', done: 1, total: 1 })).toBe(
    'Compare with what Brain knows',
  )
})
it('includes the conversation part even for a single-part stage', () => {
  for (const done of [0, 1])
    expect(progressLine({ stage: 'extract', done, total: 1 })).toBe(
      'Read the conversation · part 1 of 1',
    )
})

it('says how long each call took in words, never as a clock', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const view = mockExtractionView()
  view.calls[0]!.trace = mockCallTrace((241 * 60 + 11) * 1000)
  view.calls[1]!.trace = mockCallTrace(42_400)
  const fake = createFakePhosphor({ 'brain:extraction': async () => view })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<ReadDetail jobId="harbor-demo-review" onMemory={vi.fn()} history={null} />),
    )
    const calls = container.querySelector('[aria-label="How it was read"]')!.textContent
    expect(calls).toContain('Read the conversation · part 1 · 4 h 1 min')
    expect(calls).toContain(' · 42 s')
    expect(calls).not.toContain('241:11')
    expect([0, 59_900, 60_000].map(callDuration)).toEqual(['1 s', '59 s', '1 min'])
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
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
      root.render(<ReadDetail jobId={data.jobId} onMemory={() => {}} history={null} />),
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
    await act(async () =>
      root.render(<ReadDetail jobId={data.jobId} onMemory={() => {}} history={null} />),
    )
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

it('caps raw output, prompts and source text with their own scroll containers', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const data = mockExtractionView()
  data.calls = [{ ...data.calls[0]!, answer: 'Harbor output\n'.repeat(1500) }]
  data.prompts = ['Ledger prompt\n'.repeat(1500)]
  data.source.exists = true
  data.source.segments = [
    {
      entryId: 'harbor-entry',
      role: 'user',
      observedAt: 0,
      label: 'user · 2026-11-01',
      text: 'Kestrel source\n'.repeat(1500),
    },
  ]
  const fake = createFakePhosphor({ 'brain:extraction': () => data })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<ReadDetail jobId={data.jobId} onMemory={() => {}} history={null} />),
    )
    for (const detail of container.querySelectorAll('details'))
      await act(async () => {
        detail.open = true
        detail.dispatchEvent(new Event('toggle'))
      })
    expect(container.querySelectorAll('pre')).toHaveLength(3)
    for (const pre of container.querySelectorAll('pre'))
      expect(pre.closest('.max-h-96.overflow-auto')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})

it('says how long the model spent on a read, in words, even when its review refreshed days later', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const data = mockExtractionView()
  // Read on Monday, refreshed on Wednesday: the record spans two days, its calls 4 h 1 min.
  data.startedAt = 0
  data.finishedAt = 2 * 86_400_000
  const parts = [(200 * 60 + 11) * 1000, 40 * 60_000, 60_000]
  data.calls.forEach((call, index) => (call.trace = mockCallTrace(parts[index]!)))
  const fake = createFakePhosphor({ 'brain:extraction': async () => data })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<ReadDetail jobId={data.jobId} onMemory={() => {}} history={null} />),
    )
    expect(container.textContent).toContain('took 4 h 1 min')
    expect(container.textContent).not.toContain('241:11')
    expect(container.textContent).not.toContain('2 days')
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})

it('shows no duration when a call has no trace or the read made no calls', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const untraced = mockExtractionView()
  untraced.calls[0]!.trace = mockCallTrace(60_000)
  const uncalled = { ...mockExtractionView(), calls: [], prompts: [] }
  for (const data of [untraced, uncalled]) {
    const fake = createFakePhosphor({ 'brain:extraction': async () => data })
    const restore = installFakePhosphor(fake)
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(<ReadDetail jobId={data.jobId} onMemory={() => {}} history={null} />),
      )
      expect(container.querySelector('header')!.textContent).not.toContain('took')
    } finally {
      act(() => root.unmount())
      restore()
      fake.dispose()
    }
  }
})
