// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useChatUiStore } from './uiState'
import { ForkPickerModal } from './ForkPickerModal'

it('leaves loading on transport failure and retries without reopening the picker', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({
      success: true,
      data: { entries: [], leafId: null },
    })
  const fake = createFakePhosphor({ 'pi:command': read })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  useChatUiStore.setState({ forkPickerFor: 'lane' })
  try {
    await act(async () => root.render(<ForkPickerModal sessionId="lane" />))
    expect(document.body.textContent).toContain("Couldn't read this session's messages.")
    expect(document.body.textContent).not.toContain('Loading…')
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
    await act(async () => retry.click())
    expect(document.body.textContent).toContain('No forkable user messages yet.')
    expect(read).toHaveBeenCalledTimes(2)
  } finally {
    act(() => root.unmount())
    container.remove()
    restore()
    fake.dispose()
    vi.unstubAllGlobals()
  }
})
