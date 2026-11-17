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
import { emptyBrainTidyPage } from '@shared/brain-tidy'
import { MergeEntity } from './MergeEntity'

let root: Root,
  container: HTMLDivElement,
  fake: ReturnType<typeof createFakePhosphor>,
  restore: () => void
let status = mockBrainStatus()
const merge = vi.fn(),
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
  fake = createFakePhosphor({
    'brain:entity': read,
    'brain:merge': merge,
    'brain:status': () => status,
    'brain:tidy': () => emptyBrainTidyPage(status.revision),
    'brain:tidyUndo': () => ({ ...status, revision: 2 }),
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
  expect(prompt.message).toContain('Tom Lee · 1 memories: Ledger support lead')
  expect(prompt.message).toContain('Rina Okafor · 1 memories: Ledger migration owner')
  expect(prompt.message).toContain('You can Undo')
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
