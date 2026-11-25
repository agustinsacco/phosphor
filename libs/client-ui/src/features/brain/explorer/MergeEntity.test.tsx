// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { mockBrainStatus } from '../mockBrainData'
import { MockExplorer } from '../mockExplorer'
import { useBrain } from '../useBrain'
import { usePromptStore } from '@/stores/prompt'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { MergeEntity } from './MergeEntity'

let root: Root,
  container: HTMLDivElement,
  fake: ReturnType<typeof createFakePhosphor>,
  restore: () => void
let status = mockBrainStatus()
const merge = vi.fn(),
  undo = vi.fn(),
  read = vi.fn(),
  visit = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  status = mockBrainStatus()
  useBrain.setState({ status, saving: false, error: '' })
  useExtensionUiStore.setState({ toasts: [] })
  const explorer = new MockExplorer()
  read.mockReset().mockImplementation((id: string) => explorer.entity(id))
  merge.mockReset().mockImplementation(async () => ({
    ...status,
    revision: status.revision + 1,
    operationId: 'merge-1',
  }))
  undo.mockReset().mockImplementation(async () => ({ ...status, revision: status.revision + 1 }))
  fake = createFakePhosphor({
    'brain:entity': read,
    'brain:merge': merge,
    'brain:status': () => status,
    'brain:tidyUndo': undo,
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
  for (const request of usePromptStore.getState().requests)
    usePromptStore.getState().dismiss(request, undefined)
})
async function render() {
  await act(async () =>
    root.render(
      <MergeEntity
        sourceId="tom"
        target={{ kind: 'entity', id: 'rina', label: 'Rina Okafor' }}
        onVisit={visit}
      />,
    ),
  )
}
async function click(label: string) {
  await act(async () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === label)!.click(),
  )
}
async function answer() {
  await act(async () =>
    usePromptStore.getState().dismiss(usePromptStore.getState().requests[0]!, 'MERGE'),
  )
}
it('confirms descriptions and memory counts for both records, then offers Undo', async () => {
  await render()
  const prompt = usePromptStore.getState().requests[0]!
  expect(prompt.message).toContain('Tom Lee · 6 memories: Ledger billing lead')
  expect(prompt.message).toContain('Rina Okafor · 5 memories: Ran Ledger billing, now on Kestrel')
  expect(prompt.message).toContain('You can Undo this in What changed')
  expect(prompt.message).not.toContain('cannot be undone')
  await answer()
  expect(merge).toHaveBeenCalledWith('tom', 'rina', 0)
  expect(useExtensionUiStore.getState().toasts[0]).toMatchObject({
    openLabel: 'Undo',
    title: 'Brain',
  })
})
it('recovers a first record load failure before asking for confirmation', async () => {
  read.mockRejectedValueOnce(new Error('Entity unavailable'))
  await render()
  expect(container.textContent).toContain('Entity unavailable')
  expect(usePromptStore.getState().requests).toHaveLength(0)
  await click('Retry')
  expect(usePromptStore.getState().requests).toHaveLength(1)
})
it('reloads a stale merge and requires a new confirmation with the refreshed revision', async () => {
  merge.mockImplementationOnce(async () => {
    status = { ...status, revision: 1 }
    throw new Error('Arbitrary conflict')
  })
  await render()
  await answer()
  expect(container.textContent).toContain('Brain changed. Check this again.')
  expect(usePromptStore.getState().requests).toHaveLength(0)
  await click('Review merge…')
  await answer()
  expect(merge.mock.calls[1]![2]).toBe(1)
})
it('keeps a same-revision refusal verbatim rather than interpreting its wording', async () => {
  merge.mockRejectedValueOnce(new Error('These records cannot be combined.'))
  await render()
  await answer()
  expect(container.textContent).toContain('These records cannot be combined.')
  await click('Review merge…')
  await answer()
  expect(merge).toHaveBeenCalledTimes(2)
})

it('uses the current revision when Undo is opened from the confirmation toast', async () => {
  await render()
  await answer()
  const toast = useExtensionUiStore.getState().toasts[0]!
  status = { ...status, revision: 5 }
  await act(async () => {
    await toast.onOpen?.()
  })
  expect(undo).toHaveBeenCalledWith('merge-1', 5)
  expect(useExtensionUiStore.getState().toasts[0]!.message).toBe('Change undone')
})
it('reloads What changed and distinguishes a raced Undo from an engine refusal', async () => {
  const { useBrainNavigation } = await import('../brainNavigation')
  await render()
  await answer()
  const toast = useExtensionUiStore.getState().toasts[0]!
  undo.mockImplementationOnce(async () => {
    status = { ...status, revision: 6 }
    throw new Error('Revision mismatch')
  })
  await act(async () => {
    await toast.onOpen?.()
  })
  expect(useExtensionUiStore.getState().toasts[0]!.message).toBe('Brain changed. Check this again.')
  expect(useBrainNavigation.getState().target).toEqual({ changes: true })
  undo.mockRejectedValueOnce(new Error('Later facts prevent a clean undo.'))
  await act(async () => {
    await toast.onOpen?.()
  })
  expect(useExtensionUiStore.getState().toasts[0]!.message).toBe(
    'Later facts prevent a clean undo.',
  )
})

it('reloads a refused Knowledge merge without using the removed Tidy surface', async () => {
  merge.mockRejectedValueOnce(new Error('These records cannot be combined.'))
  await render()
  await answer()
  expect(container.textContent).toContain('These records cannot be combined.')
})
