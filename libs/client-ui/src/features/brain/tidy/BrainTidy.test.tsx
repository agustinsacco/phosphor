// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IpcInvokeMap } from '@shared/ipc'
import type { BrainStatus } from '@shared/brain'
import type { BrainTidyPage } from '@shared/brain-tidy'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useBrain } from '../useBrain'
import { createMockBrain } from '../mockBrain'
import { BrainTidy } from './BrainTidy'
import { useExtensionUiStore } from '@/stores/extensionUi'

let root: Root,
  container: HTMLDivElement,
  fake: ReturnType<typeof createFakePhosphor>,
  restore: () => void
let mock: ReturnType<typeof createMockBrain>, status: BrainStatus
const list = vi.fn(),
  detail = vi.fn(),
  changes = vi.fn(),
  apply = vi.fn(),
  undo = vi.fn(),
  history = vi.fn()
const visit = vi.fn()
async function call<K extends keyof IpcInvokeMap>(
  channel: K,
  ...args: IpcInvokeMap[K]['args']
): Promise<IpcInvokeMap[K]['result']> {
  return (await mock(channel, args)) as IpcInvokeMap[K]['result']
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mock = createMockBrain(() => 10000, { count: 60 })
  status = await call('brain:status')
  status.prefs.enabled = true
  useBrain.setState({ status, saving: false, error: '' })
  useExtensionUiStore.setState({ toasts: [] })
  list.mockReset().mockImplementation((...args) => mock('brain:tidy', args))
  detail.mockReset().mockImplementation((...args) => mock('brain:tidySuggestion', args))
  changes.mockReset().mockImplementation((...args) => mock('brain:tidyChanges', args))
  history.mockReset().mockResolvedValue({ items: [], more: false })
  apply.mockReset().mockImplementation((...args) => mock('brain:tidyApply', args))
  undo.mockReset().mockImplementation((...args) => mock('brain:tidyUndo', args))
  fake = createFakePhosphor({
    'brain:status': () => call('brain:status'),
    'brain:tidy': list,
    'brain:tidySuggestion': detail,
    'brain:tidyChanges': changes,
    'brain:history': history,
    'brain:tidyApply': apply,
    'brain:tidyUndo': undo,
    'brain:tidyDismiss': (...args) => call('brain:tidyDismiss', ...args),
    'brain:tidyRun': () => call('brain:tidyRun'),
    'brain:tidyCancel': () => call('brain:tidyCancel'),
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
  vi.unstubAllGlobals()
})
async function render(active = true) {
  await act(async () => root.render(<BrainTidy active={active} onVisit={visit} />))
}
async function click(label: string, index = 0) {
  const button = [...container.querySelectorAll('button')].filter((b) => b.textContent === label)[
    index
  ]
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
it('groups and pages 60 suggestions, supports keyboard rows and keeps selection on reload', async () => {
  await render()
  expect(container.querySelectorAll('[data-tidy-row]')).toHaveLength(20)
  expect(container.textContent).toContain('Same person or thing? · 15')
  await click('Show more')
  expect(container.querySelectorAll('[data-tidy-row]')).toHaveLength(40)
  const rows = container.querySelectorAll<HTMLButtonElement>('[data-tidy-row]')
  await act(async () => {
    rows[0]!.focus()
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  expect(document.activeElement).toBe(rows[1])
  await act(async () => rows[1]!.click())
  const selected = container.querySelector('[aria-current="true"]')!.textContent
  await act(async () => useBrain.setState({ status: { ...status, revision: 1 } }))
  expect(container.querySelector('[aria-current="true"]')!.textContent).toBe(selected)
  expect(container.querySelectorAll('[data-tidy-row]')).toHaveLength(40)
})
it('recovers the first list, detail, changes and reader-model failures with Retry', async () => {
  list.mockRejectedValueOnce(new Error('List unavailable'))
  changes.mockRejectedValueOnce(new Error('Changes unavailable'))
  history.mockRejectedValueOnce(new Error('Reader unavailable'))
  detail.mockRejectedValueOnce(new Error('Detail unavailable'))
  await render()
  expect(container.textContent).toContain('List unavailable')
  await click('Retry')
  expect(container.textContent).toContain('Detail unavailable')
  await click('Retry')
  await click('Retry recent changes')
  await click('Retry reader model')
  expect(container.querySelector('[aria-label="Tidy suggestion"]')).not.toBeNull()
  expect(container.textContent).not.toContain('unavailable')
})
it('ignores an older page reply and preserves the swapped survivor while the tab is hidden', async () => {
  let resolve!: (value: BrainTidyPage) => void
  list.mockImplementationOnce(
    () =>
      new Promise<BrainTidyPage>((r) => {
        resolve = r
      }),
  )
  await render()
  await render(false)
  await render()
  const before = container.querySelectorAll('[data-tidy-row]').length
  await act(async () => resolve({ ...(await call('brain:tidy', null, null, 20)), items: [] }))
  expect(container.querySelectorAll('[data-tidy-row]')).toHaveLength(before)
  await click('Swap surviving record')
  await render(false)
  await render()
  expect(container.textContent).toContain('Merge into Rina')
})
it('selects the next suggestion after an action, journals it and offers Undo', async () => {
  await render()
  await click('Merge into Rina Okafor')
  expect(apply).toHaveBeenCalledWith('tidy-0', { kind: 'merge', survivorId: 'tidy-0-0' }, 0)
  expect(container.querySelector('[aria-label="Tidy suggestion"]')?.textContent).toContain(
    'Keep this one',
  )
  expect(container.querySelector('[aria-label="Recent changes"]')).not.toBeNull()
  expect(
    useExtensionUiStore.getState().toasts.find((t) => t.message === 'Brain updated')?.openLabel,
  ).toBe('Undo')
  await click('Undo')
  expect(undo).toHaveBeenCalledWith('operation-0', 1)
  expect(container.textContent).toContain('Undone')
})
it('reloads rather than replaying a stale apply and keeps the new detail actionable', async () => {
  apply.mockImplementationOnce(async () => {
    await call('brain:tidyDismiss', 'tidy-59', 0)
    throw new Error('Revision mismatch with an arbitrary message')
  })
  await render()
  await click('Merge into Rina Okafor')
  expect(container.textContent).toContain('Brain changed. Check this again.')
  expect(apply).toHaveBeenCalledOnce()
  await click('Merge into Rina Okafor')
  expect(apply.mock.calls[1]![2]).toBe(1)
})
it('shows a refusal unchanged when the revision did not move and can retry the action', async () => {
  apply.mockRejectedValueOnce(new Error('These records have different scopes.'))
  await render()
  await click('Merge into Rina Okafor')
  expect(container.textContent).toContain('These records have different scopes.')
  await click('Merge into Rina Okafor')
  expect(apply).toHaveBeenCalledTimes(2)
})
it('selects the next suggestion and explains an already-settled failure', async () => {
  apply.mockImplementationOnce(async () => {
    await call('brain:tidyDismiss', 'tidy-0', 0)
    throw new Error('No longer open')
  })
  await render()
  await click('Merge into Rina Okafor')
  expect(container.textContent).toContain('This suggestion was already settled.')
  expect(container.querySelector('[aria-label="Tidy suggestion"]')?.textContent).toContain(
    'Keep this one',
  )
})
it('leaves a refused Undo visible with the engine reason', async () => {
  undo.mockRejectedValueOnce(new Error('Later changes prevent a clean undo.'))
  await render()
  await click('Merge into Rina Okafor')
  await click('Undo')
  expect(container.textContent).toContain('Later changes prevent a clean undo.')
  await click('Undo')
  expect(undo).toHaveBeenCalledTimes(2)
})

it('advances in the visible grouped order rather than the interleaved response order', async () => {
  await render()
  await click('Merge into Rina Okafor')
  expect(detail).toHaveBeenLastCalledWith('tidy-4')
})

it('keeps a swapped survivor, not just the row, after hiding and reopening Tidy', async () => {
  await render()
  await click('Swap surviving record')
  await render(false)
  await render()
  const merge = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Merge into'))!
  expect(merge.textContent).toBe('Merge into Rina')
})
