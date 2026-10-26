import { afterEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { openSidebarConversation } from './completionActions'

vi.mock('@/stores/sessions', () => ({ useSessionsStore: { getState: () => ({}) } }))
vi.mock('@/stores/remoteLanes', () => ({ alignLaneMachineFilter: vi.fn() }))
vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn(), presentText: vi.fn() }))

afterEach(() => vi.unstubAllGlobals())

it('does not require checkout restoration to read a removed lane', () => {
  const invoke = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { phosphor: { invoke } })
  openSidebarConversation('/repo', {
    path: '/sessions/legacy.jsonl',
    cwd: '/repo/.phosphor/worktrees/legacy',
    worktreeRemoved: true,
  } as SessionMeta)
  expect(invoke).not.toHaveBeenCalledWith(
    'sessions:restoreWorktree',
    '/repo/.phosphor/worktrees/legacy',
  )
})
