// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ArchiveMachine } from './ArchiveMachine'
import { PurgeArchiveModal } from './PurgeArchiveModal'
import { ArchiveSessionModal } from '../sessions/ArchiveConfirm'
import { useSessionsStore } from '@/stores/sessions'
import { useArchivesStore } from '@/stores/archives'

const container = document.createElement('div')
const root = createRoot(container)
document.body.append(container)
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((button) => button.textContent === label)!
afterEach(() => {
  act(() => root.render(null))
  useArchivesStore.setState({ machines: {} })
  vi.restoreAllMocks()
})
it('archives, never deletes, and keeps the confirmation open after a failed first attempt', async () => {
  const remove = vi
    .spyOn(useSessionsStore.getState(), 'deleteSession')
    .mockRejectedValueOnce(new Error('Archive unavailable'))
    .mockResolvedValueOnce(undefined)
  const close = vi.fn()
  const target = { sessionId: 'pending', workspacePath: '/repo', title: 'Keep my files' }
  act(() => root.render(<ArchiveSessionModal target={target} onClose={close} />))
  await act(async () => button('Archive lane').click())
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Archive unavailable')
  expect(close).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('uncommitted, untracked and ignored')
  await act(async () => button('Archive lane').click())
  expect(remove).toHaveBeenCalledWith('/repo', { ...target, archive: true })
  expect(close).toHaveBeenCalledOnce()
})
it('recovers an archive page whose first read failed without treating unknown storage as zero', async () => {
  const invoke = vi
    .fn()
    .mockRejectedValueOnce(new Error('Temporarily unavailable'))
    .mockResolvedValue({
      entries: [],
      bytes: 0,
      measuredAt: Date.now(),
      measuring: false,
      truncated: false,
    })
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  await act(async () => root.render(<ArchiveMachine machine="local" />))
  expect(document.body.textContent).toContain('Temporarily unavailable')
  expect(document.body.textContent).toContain('Storage unknown')
  await act(async () => button('Refresh').click())
  expect(document.body.textContent).toContain('No archived lanes')
  expect(document.body.textContent).not.toContain('Temporarily unavailable')
  expect(invoke).toHaveBeenLastCalledWith('sessions:archives', true)
})
it('keeps the checkout by default and requires renewed acknowledgement after choosing to destroy it', () => {
  const confirm = vi.fn()
  const entry = {
    id: 'a'.repeat(64),
    cwd: '/repo/worktree',
    title: 'Lane',
    archivedAt: 0,
    state: 'archived' as const,
    worktree: true,
  }
  act(() =>
    root.render(
      <PurgeArchiveModal
        entry={entry}
        busy={false}
        error={null}
        onClose={vi.fn()}
        onConfirm={confirm}
      />,
    ),
  )
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(inputs.map((input) => input.checked)).toEqual([false, false])
  expect(button('Permanently clean up').disabled).toBe(true)
  act(() => inputs[1]!.click())
  act(() => button('Permanently clean up').click())
  expect(confirm).toHaveBeenLastCalledWith(false)
  act(() => inputs[0]!.click())
  expect(button('Permanently clean up').disabled).toBe(true)
  act(() => inputs[1]!.click())
  act(() => button('Permanently clean up').click())
  expect(confirm).toHaveBeenLastCalledWith(true)
})
