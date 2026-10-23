// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMeta, WorktreeRecovery } from '@shared/models'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { openRestoreWorktree, useRestoreWorktree, useSavedConversation } from './completionActions'
import { RestoreWorktreeModal } from './RestoreWorktreeModal'

const sessions = vi.hoisted(() => ({
  refreshDisk: vi.fn(async () => undefined),
  openDiskSession: vi.fn(async () => 'live-1'),
}))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: { getState: () => sessions } }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => 'light' }))

const lane = '/repo/.phosphor/worktrees/lane'
const meta = { path: '/sessions/lane.jsonl', cwd: lane, worktreeRemoved: true } as SessionMeta
const recovery: WorktreeRecovery = {
  editedFiles: [],
  editedFileCount: 0,
  branch: { name: 'agustin/lane', tip: '0123456789', subject: 'Work', remoteOnly: false },
  fresh: { base: 'origin/main', branch: 'phosphor/lane' },
}
let root: Root | undefined
let cleanup: Array<() => void> = []

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => root?.unmount())
  useRestoreWorktree.setState({ target: null })
  useSavedConversation.setState({ meta: null })
  for (const undo of cleanup) undo()
  cleanup = []
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function render(handlers: Parameters<typeof createFakePhosphor>[0]) {
  const fake = createFakePhosphor(handlers)
  cleanup.push(installFakePhosphor(fake), fake.dispose)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<RestoreWorktreeModal />))
}
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text)!

it('recovers a failed first load, then recreates from the chosen source', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('git busy')).mockResolvedValueOnce(recovery)
  const recreate = vi.fn(async () => undefined)
  openRestoreWorktree('/repo', meta)
  await render({ 'sessions:worktreeRecovery': load, 'sessions:recreateWorktree': recreate })
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('git busy')
  await act(async () => button('Retry').click())
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  expect(radios.map((r) => [r.value, r.checked])).toEqual([
    ['branch', true],
    ['fresh', false],
  ])
  expect(document.body.textContent).toContain('did not edit or write files')
  await act(async () => radios[1]!.click())
  await act(async () => button('Restore').click())
  expect(recreate).toHaveBeenCalledWith(lane, 'fresh')
  expect(sessions.refreshDisk).toHaveBeenCalledWith('/repo')
  expect(sessions.openDiskSession).not.toHaveBeenCalled()
  expect(useRestoreWorktree.getState().target).toBeNull()
})

it('keeps the dialog open with the error when recreation fails', async () => {
  openRestoreWorktree('/repo', meta)
  await render({
    'sessions:worktreeRecovery': async () => recovery,
    'sessions:recreateWorktree': async () => {
      throw new Error('Branch is checked out elsewhere')
    },
  })
  await act(async () => button('Restore').click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('checked out elsewhere')
  expect(useRestoreWorktree.getState().target).not.toBeNull()
})

it('restores the saved commit and continues the conversation from the reader', async () => {
  const restore = vi.fn(async () => undefined)
  useSavedConversation.setState({ meta, workspace: '/repo' })
  openRestoreWorktree('/repo', meta, true)
  await render({
    'sessions:worktreeRecovery': async () => ({
      ...recovery,
      saved: { tip: 'abcdef0123', branch: 'agustin/lane' },
    }),
    'sessions:restoreWorktree': restore,
  })
  await act(async () => button('Restore and continue').click())
  expect(restore).toHaveBeenCalledWith(lane)
  expect(useSavedConversation.getState().meta).toBeNull()
  expect(sessions.openDiskSession).toHaveBeenCalledWith('/repo', {
    ...meta,
    worktreeRemoved: false,
  })
})

it('explains why nothing can be offered', async () => {
  openRestoreWorktree('/repo', meta)
  await render({
    'sessions:worktreeRecovery': async () => ({
      editedFiles: [],
      editedFileCount: 0,
      unavailable: 'The repository /repo is missing.',
    }),
  })
  expect(document.body.textContent).toContain('The repository /repo is missing.')
  expect(button('Restore')).toBeUndefined()
})
