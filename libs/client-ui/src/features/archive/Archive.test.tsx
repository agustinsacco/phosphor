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
  await act(async () => root.render(<ArchiveMachine machine="local" query="" />))
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

const archived = (n: number, worktree = false) => ({
  id: String(n).repeat(64),
  cwd: `/repo/lane-${n}`,
  title: `Lane ${n}`,
  archivedAt: 1_700_000_000_000 - n * 1000,
  state: 'archived' as const,
  ...(worktree ? { worktree: true } : {}),
})

it('labels only the button whose operation is running', async () => {
  let settleRestore!: () => void
  const pending = new Promise<void>((resolve) => (settleRestore = resolve))
  const list = {
    entries: [archived(1)],
    bytes: 0,
    measuredAt: Date.now(),
    measuring: false,
    truncated: false,
  }
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'sessions:archives') return list
    if (channel === 'sessions:restoreArchive') {
      await pending
      return { path: '/repo/lane-1.jsonl', cwd: '/repo/lane-1' }
    }
    return undefined
  })
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  vi.spyOn(useSessionsStore.getState(), 'refreshDisk').mockResolvedValue(undefined)
  await act(async () => root.render(<ArchiveMachine machine="local" query="" />))

  await act(async () => button('Restore').click())
  // The row shares one busy flag with its sibling, so "Clean up…" must not
  // claim to be working just because a restore is in flight.
  expect(button('Restoring…')).toBeTruthy()
  expect(button('Clean up…')).toBeTruthy()
  expect(button('Cleaning up…')).toBeUndefined()

  await act(async () => {
    settleRestore()
    await pending
  })
  expect(button('Restore')).toBeTruthy()
})

it('cleans up the whole selection in one confirm, and keeps the checkout unless asked', async () => {
  const list = {
    entries: [archived(1), archived(2), archived(3, true)],
    bytes: 500_000_000,
    measuredAt: Date.now(),
    measuring: false,
    truncated: false,
  }
  const invoke = vi.fn(async (channel: string) =>
    channel === 'sessions:archives' ? list : undefined,
  )
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  await act(async () => root.render(<ArchiveMachine machine="local" query="" />))
  expect(document.body.textContent).toContain('Lane 3')

  act(() => button('Select all').click())
  const bar = document.querySelector('[data-testid="bulk-bar"]')!
  expect(bar.textContent).toContain('3 selected')
  const cleanUp = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Clean up…')!
  act(() => cleanUp.click())

  const confirm = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Clean up 3 archived lanes'),
  )!
  expect(confirm.disabled).toBe(true)
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(inputs).toHaveLength(2)
  act(() => inputs[1]!.click())
  expect(confirm.disabled).toBe(false)
  await act(async () => confirm.click())

  for (const n of [1, 2, 3])
    expect(invoke).toHaveBeenCalledWith('sessions:purgeArchive', String(n).repeat(64), false)
  expect(document.querySelector('[data-testid="bulk-bar"]')).toBeNull()
})
