// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { openBrainSource } from './openBrainSource'
import { useSessionsStore } from '@/stores/sessions'
import { navigateToLane } from '@/stores/remoteLanes'
import { openSidebarConversation } from '@/features/sessions/completionActions'

vi.mock('@/stores/sessions', () => ({ useSessionsStore: { getState: vi.fn() } }))
vi.mock('@/stores/remoteLanes', () => ({ navigateToLane: vi.fn(async () => true) }))
vi.mock('@/features/sessions/completionActions', () => ({ openSidebarConversation: vi.fn() }))

const meta: SessionMeta = {
  path: '/made-up/harbor.jsonl',
  sessionId: 'harbor-lane',
  cwd: '/projects/harbor',
  createdAt: '2026-11-06',
  name: 'Harbor billing',
  firstUserText: 'Rina Okafor owns billing.',
  userMessages: 1,
  assistantMessages: 0,
  toolCalls: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  headroomSavedTokens: 0,
  entryCount: 1,
  branchCount: 0,
  mtimeMs: 1,
  lastActivityAt: '2026-11-06',
}
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
const openDiskSession = vi.fn(async () => 'harbor-live')
const refreshDisk = vi.fn(async () => {})
beforeEach(() => {
  vi.clearAllMocks()
  fake = createFakePhosphor({
    'sessions:readTree': async () => ({
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      entries: [],
      leafId: 'leaf',
    }),
  })
  restore = installFakePhosphor(fake)
  vi.mocked(useSessionsStore.getState).mockReturnValue({
    live: {},
    disk: { [meta.cwd]: [meta] },
    openDiskSession,
    refreshDisk,
  } as unknown as ReturnType<typeof useSessionsStore.getState>)
})
afterEach(() => {
  restore()
  fake.dispose()
})

it('opens a stopped source through the current sidebar metadata and navigates to that lane', async () => {
  await openBrainSource(meta.path)
  expect(refreshDisk).toHaveBeenCalledWith(meta.cwd)
  expect(openDiskSession).toHaveBeenCalledWith(meta.cwd, meta)
  expect(navigateToLane).toHaveBeenCalledWith({ sessionId: 'harbor-live' })
})
it('uses retained-history handling rather than starting a removed checkout', async () => {
  const removed = { ...meta, worktreeRemoved: true }
  vi.mocked(useSessionsStore.getState).mockReturnValue({
    live: {},
    disk: { [meta.cwd]: [removed] },
    openDiskSession,
    refreshDisk,
  } as unknown as ReturnType<typeof useSessionsStore.getState>)
  await openBrainSource(meta.path)
  expect(openSidebarConversation).toHaveBeenCalledWith(meta.cwd, removed)
  expect(openDiskSession).not.toHaveBeenCalled()
})
it('reports a deleted source instead of creating a different lane', async () => {
  vi.mocked(useSessionsStore.getState).mockReturnValue({
    live: {},
    disk: {},
    openDiskSession,
    refreshDisk,
  } as unknown as ReturnType<typeof useSessionsStore.getState>)
  await expect(openBrainSource(meta.path)).rejects.toThrow('Source lane is no longer available')
  expect(openDiskSession).not.toHaveBeenCalled()
})
