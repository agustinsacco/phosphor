// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainKnowledge, BrainStatus } from '@shared/brain'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { BrainPage } from './BrainPage'
import { mockBrainData, mockBrainJob, mockBrainStatus } from './mockBrainData'
import { useBrain } from './useBrain'

let root: Root
let container: HTMLDivElement
let status: BrainStatus
let knowledge: BrainKnowledge
const sample = mockBrainData()
const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  status = { ...mockBrainStatus(), prefs: { enabled: true, recall: true, review: true } }
  knowledge = { entities: [], memories: [], truncated: false }
  useBrain.setState({ status: null, saving: false, error: '' })
  useExtensionUiStore.setState({ toasts: [] })
  useSettingsUiStore.setState({ open: false })
  invoke.mockReset().mockImplementation(async (channel: string, id: string) => {
    if (channel === 'brain:status') return structuredClone(status)
    if (channel === 'brain:knowledge') return structuredClone(knowledge)
    if (channel === 'brain:proposal')
      return {
        job: status.jobs.find((job) => job.id === id),
        summary: 'Harbor settled its database and ownership.',
        revision: status.revision,
        ...sample,
        memories: sample.details,
      }
    if (channel === 'brain:memory') return sample.details.find((detail) => detail.memory.id === id)
    if (channel === 'brain:forget') {
      knowledge = { ...knowledge, memories: knowledge.memories.filter((m) => m.id !== id) }
      status = {
        ...status,
        revision: status.revision + 1,
        counts: { ...status.counts, memories: knowledge.memories.length },
      }
    }
    if (channel === 'brain:review') status = { ...status, jobs: [], revision: status.revision + 1 }
    return structuredClone(status)
  })
  vi.stubGlobal('phosphor', { invoke })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(): Promise<void> {
  await act(async () => root.render(<BrainPage />))
}
async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text || b.getAttribute('aria-label') === text,
  )
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
function approved(): void {
  knowledge = {
    entities: sample.entities,
    memories: sample.details.map((d) => d.memory),
    truncated: false,
  }
  status.counts = { memories: 2, entities: 3 }
}

it('shows the one empty state and opens Settings → Brain', async () => {
  await render()
  expect(container.textContent).toContain('No knowledge yet')
  expect(container.textContent).toContain(
    'Right-click a lane and choose Queue for knowledge extraction. Brain reads a private copy of it and proposes memories for you to approve.',
  )
  expect(container.querySelector('nav')).toBeNull()
  await click('Settings')
  expect(useSettingsUiStore.getState()).toMatchObject({ open: true, tab: 'brain' })
})

it('shows inbox only with waiting, queued, running, empty and failed states', async () => {
  status.jobs = [
    mockBrainJob({ id: 'wait', state: 'waiting' }),
    mockBrainJob({ id: 'run', state: 'running', startedAt: Date.now() - 12000 }),
    mockBrainJob({ id: 'queue', state: 'queued' }),
    mockBrainJob({ id: 'empty', state: 'empty' }),
    mockBrainJob({ id: 'failed', state: 'failed', error: 'Demo fork failed' }),
  ]
  await render()
  expect(container.textContent).toContain('Waits until the lane is idle')
  expect(container.textContent).toContain('Queued · 1 ahead')
  expect(container.textContent).toContain('Reading a private copy · 0:12')
  expect(container.textContent).toContain('Nothing new worth keeping')
  expect(container.textContent).toContain('Demo fork failed')
  expect(container.textContent).toContain('Nothing approved yet')
  expect(container.querySelector('svg[aria-label="Memory relationships"]')).toBeNull()
  await click('Cancel')
  expect(invoke).toHaveBeenCalledWith('brain:cancel', 'wait')
  await click('Dismiss')
  expect(invoke).toHaveBeenCalledWith('brain:cancel', 'empty')
})

it('reviews grouped proposals, expands quotes and approves only checked indexes', async () => {
  status.jobs = [mockBrainJob()]
  status.revision = 7
  await render()
  await click('Review')
  expect(container.textContent).toContain('Harbor · read by demo/harbor-model in 0:48')
  expect(container.textContent).toContain('Nothing is searchable until you approve it.')
  expect(container.textContent).not.toMatch(/cost|\$/i)
  expect(container.querySelectorAll('details')).toHaveLength(2)
  expect(container.querySelector('mark')?.textContent).toBe('Harbor uses PostgreSQL')
  const boxes = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
  expect([...boxes].every((box) => box.checked)).toBe(true)
  await act(async () => boxes[0]!.click())
  await click('Approve 1')
  expect(invoke).toHaveBeenCalledWith('brain:review', 'harbor-job', [1], 7)
  expect(container.querySelector('[aria-label="Review memories"]')).toBeNull()
})

it('supports check all, disabled zero approval, reject all and back to graph', async () => {
  status.jobs = [mockBrainJob()]
  await render()
  await click('Review')
  await click('Uncheck all')
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Approve 0',
    )?.disabled,
  ).toBe(true)
  await click('Check all')
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(
      (box) => box.checked,
    ),
  ).toBe(true)
  await click('Back to graph')
  expect(container.querySelector('[aria-label="Review memories"]')).toBeNull()
  await click('Review')
  await click('Reject all')
  expect(invoke).toHaveBeenCalledWith('brain:review', 'harbor-job', null, 0)
})

it('shows grouped memories, graph, entity focus, detail quotes and forget', async () => {
  approved()
  await render()
  expect(container.textContent).toContain('2 memories · 3 things')
  expect(container.textContent).toContain('Decisions · 1')
  expect(container.textContent).toContain('Facts · 1')
  expect(container.querySelector('svg[aria-label="Memory relationships"]')).not.toBeNull()
  await act(async () =>
    container
      .querySelector('[aria-label="Focus Rina Okafor"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  )
  expect(container.textContent).toContain('About Rina Okafor ×')
  expect(container.querySelector('[aria-label=Memories]')?.textContent).not.toContain(
    sample.details[0]!.memory.summary,
  )
  await click('About Rina Okafor ×')
  const summary = sample.details[0]!.memory.summary
  const row = [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label=Memories] button'),
  ].find((b) => b.textContent?.includes(summary))!
  await act(async () => row.click())
  const detail = container.querySelector('[aria-label="Memory detail"]')!
  expect(detail.querySelector('mark')?.textContent).toBe('Harbor uses PostgreSQL')
  expect(detail.textContent).toContain('From Harbor billing decisions')
  expect(detail.textContent).toContain('reported')
  await click('Forget')
  expect(invoke).toHaveBeenCalledWith('brain:forget', 'harbor-db')
  expect(
    useExtensionUiStore.getState().toasts.some((toast) => toast.message === 'Memory forgotten'),
  ).toBe(true)
  expect(container.querySelector('[aria-label="Memory detail"]')).toBeNull()
})

it('filters memory text and relationship labels', async () => {
  approved()
  await render()
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search memories"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'PostgreSQL',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const list = container.querySelector('[aria-label=Memories]')!
  expect(list.textContent).toContain('Decisions · 1')
  expect(list.textContent).not.toContain('Facts · 1')
})

it('recovers from the first failed knowledge load with Retry', async () => {
  const normal = invoke.getMockImplementation()!
  invoke
    .mockImplementationOnce(normal)
    .mockRejectedValueOnce(new Error('Demo knowledge unavailable'))
  await render()
  expect(container.textContent).toContain('Demo knowledge unavailable')
  await click('Retry')
  expect(container.textContent).toContain('No knowledge yet')
})

it('keeps a rejected review open and surfaces the error in a toast', async () => {
  status.jobs = [mockBrainJob()]
  await render()
  await click('Review')
  const normal = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'brain:review')
      throw new Error('Brain changed while you were reviewing. Reopen the review.')
    return normal(channel, ...args)
  })
  await click('Approve 2')
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
  expect(
    useExtensionUiStore.getState().toasts.some((toast) => toast.message.includes('Brain changed')),
  ).toBe(true)
})

it('never loads local knowledge on a browser platform', async () => {
  await act(async () =>
    root.render(
      <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
        <BrainPage />
      </PlatformProvider>,
    ),
  )
  expect(container.textContent).toContain('Brain is available on Desktop')
  expect(container.textContent).not.toContain('Settings')
  expect(invoke).not.toHaveBeenCalled()
})

it('recovers a failed first proposal load without leaving the review', async () => {
  status.jobs = [mockBrainJob()]
  await render()
  const normal = invoke.getMockImplementation()!
  let failed = false
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'brain:proposal' && !failed) {
      failed = true
      throw new Error('Demo proposal unavailable')
    }
    return normal(channel, ...args)
  })
  await click('Review')
  expect(container.textContent).toContain('Demo proposal unavailable')
  await click('Retry')
  expect(container.querySelector('[aria-label="Review memories"]')).not.toBeNull()
})

it('recovers a failed first memory load and focuses an entity from its detail', async () => {
  approved()
  await render()
  const normal = invoke.getMockImplementation()!
  let failed = false
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'brain:memory' && !failed) {
      failed = true
      throw new Error('Demo memory unavailable')
    }
    return normal(channel, ...args)
  })
  const row = [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label=Memories] button'),
  ].find((button) => button.textContent?.includes(sample.details[0]!.memory.summary))!
  await act(async () => row.click())
  expect(container.textContent).toContain('Demo memory unavailable')
  await click('Retry')
  await click('PostgreSQL')
  expect(container.textContent).toContain('About PostgreSQL ×')
})
