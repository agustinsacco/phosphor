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

const list = (n: number) => ({
  entries: Array.from({ length: n }, (_, i) => archived(i + 1)),
  bytes: 0,
  measuredAt: Date.now(),
  measuring: false,
  truncated: false,
})

it('selects from the row box, so a permanent cleanup can be narrowed', async () => {
  const invoke = vi.fn(async (channel: string) =>
    channel === 'sessions:archives' ? list(2) : undefined,
  )
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  await act(async () => root.render(<ArchiveMachine machine="local" query="" />))
  const box = (n: number) =>
    document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="Select Lane ${n}"]`)!
  // A selectable row must not carry a block reason: any string kills the box.
  expect(box(1).getAttribute('aria-disabled')).toBeNull()
  act(() => box(1).click())
  expect(document.querySelector('[data-testid="bulk-bar"]')?.textContent).toContain('1 selected')
  act(() => box(2).click())
  expect(document.querySelector('[data-testid="bulk-bar"]')?.textContent).toContain('2 selected')
  act(() => box(1).click())
  expect(document.querySelector('[data-testid="bulk-bar"]')?.textContent).toContain('1 selected')
})

it('keeps the confirmation open when the machine refuses a cleanup', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'sessions:archives') return list(1)
    throw new Error('Worktree is shared by another lane.')
  })
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  await act(async () => root.render(<ArchiveMachine machine="local" query="" />))
  act(() => button('Clean up…').click())
  const confirm = button('Permanently clean up')
  act(() => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.click())
  await act(async () => confirm.click())
  // The dialog is the only place that explains a refusal. The failed cleanup
  // refreshes the list, and a list that blanks remounts the dialog out from
  // under the reader, resetting the acknowledgement they just gave.
  expect(document.body.textContent).toContain('Clean up “Lane 1”?')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('shared by another lane')
  expect(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.checked).toBe(
    true,
  )
})

it('keeps cleaning up after one lane is refused, and says what survived', async () => {
  const refused = '2'.repeat(64)
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'sessions:archives') return list(3)
    if (channel === 'sessions:purgeArchive' && args[0] === refused)
      throw new Error('Worktree is shared by another lane.')
    return undefined
  })
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  await act(async () => root.render(<ArchiveMachine machine="local" query="" />))

  act(() => button('Select all').click())
  const bar = document.querySelector('[data-testid="bulk-bar"]')!
  act(() => [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Clean up…')!.click())
  const confirm = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Clean up 3 archived lanes'),
  )!
  act(() => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.click())
  await act(async () => confirm.click())

  // The refusal belongs to one lane, so the rows after it still go.
  expect(invoke).toHaveBeenCalledWith('sessions:purgeArchive', '3'.repeat(64), false)
  expect(document.body.textContent).toContain('2 cleaned up, 1 kept.')
  expect(document.body.textContent).toContain('Lane 2: Worktree is shared by another lane.')
})
