// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionsStore } from '@/stores/sessions'
import { DeleteSessionModal } from './DeleteSessionModal'

const container = document.createElement('div')
const root = createRoot(container)
afterEach(() => {
  act(() => root.render(null))
  vi.restoreAllMocks()
})

it('keeps a failed deletion visible and allows retry on a live-only session', async () => {
  const remove = vi
    .spyOn(useSessionsStore.getState(), 'deleteSession')
    .mockRejectedValueOnce(new Error('Trash unavailable'))
    .mockResolvedValueOnce(undefined)
  const close = vi.fn()
  const target = { sessionId: 'pending', workspacePath: '/repo', title: 'Yo Project' }
  act(() => root.render(<DeleteSessionModal target={target} onClose={close} />))
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Delete session',
  )!
  await act(async () => button.click())
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Trash unavailable')
  expect(button.disabled).toBe(false)
  expect(close).not.toHaveBeenCalled()
  await act(async () => button.click())
  expect(remove).toHaveBeenCalledWith('/repo', target)
  expect(close).toHaveBeenCalledOnce()
})
