import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { usePromptStore } from '@/stores/prompt'
import { copySpend } from './sessionActions'

const writeText = vi.fn()

beforeEach(() => {
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  writeText.mockReset()
  useExtensionUiStore.setState({ toasts: [] })
  usePromptStore.setState({ requests: [] })
})
afterEach(() => vi.unstubAllGlobals())

it('copies spend as the row shows it, and says so, as Copy debug info does', async () => {
  writeText.mockResolvedValue(undefined)
  await expect(copySpend(1.5)).resolves.toBeUndefined()
  expect(writeText).toHaveBeenCalledWith('$1.50')
  expect(useExtensionUiStore.getState().toasts.map((t) => t.message)).toEqual(['Spend copied'])
})

it('shows the spend to copy by hand when the clipboard is denied, as Copy debug info does', async () => {
  writeText.mockRejectedValue(new Error('denied'))
  const copied = copySpend(1.5)
  await vi.waitFor(() => expect(usePromptStore.getState().requests).toHaveLength(1))
  expect(usePromptStore.getState().requests[0]).toMatchObject({
    title: 'Copy spend',
    text: '$1.50',
  })
  usePromptStore.getState().requests[0]!.resolve(undefined)
  await expect(copied).resolves.toBeUndefined()
})
