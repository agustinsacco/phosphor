import { beforeEach, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { piCallOk } from '@/lib/rpc'
import { renameLane } from './remoteLaneSessionHelpers'
import { renameSidebarSession } from './sidebarActions'
import { useSessionsStore } from '@/stores/sessions'
import type { SessionMeta } from '@shared/models'

vi.mock('@/lib/rpc', () => ({ piCall: vi.fn(), piCallOk: vi.fn() }))

beforeEach(() => {
  vi.mocked(piCallOk).mockReset()
  useChatStore.setState({ sessions: { s1: { items: [], meta: { sessionName: 'Old' } } } as never })
})

it('names a running Host lane through pi and shows the name in its chat', async () => {
  vi.mocked(piCallOk).mockResolvedValue(true as never)
  await renameLane('s1', 'New name')
  expect(piCallOk).toHaveBeenCalledWith('s1', { type: 'set_session_name', name: 'New name' })
  expect(useChatStore.getState().sessions.s1?.meta?.sessionName).toBe('New name')
})

it('throws to its dialog runner when pi refuses, keeping the old name', async () => {
  vi.mocked(piCallOk).mockResolvedValue(false as never)
  await expect(renameLane('s1', 'New name')).rejects.toThrow()
  expect(useChatStore.getState().sessions.s1?.meta?.sessionName).toBe('Old')
})

it('renames a This Mac row through pi and rescans its folder only on success', async () => {
  const refreshDisk = vi.fn(async () => {})
  const openDiskSession = vi.fn(async () => 's1')
  useSessionsStore.setState({ refreshDisk, openDiskSession } as never)
  const meta = { path: '/w/s.jsonl' } as SessionMeta
  vi.mocked(piCallOk).mockResolvedValue(true as never)
  await renameSidebarSession('/w', meta, '  Trimmed  ')
  expect(openDiskSession).toHaveBeenCalledWith('/w', meta)
  expect(piCallOk).toHaveBeenCalledWith('s1', { type: 'set_session_name', name: 'Trimmed' })
  expect(useChatStore.getState().sessions.s1?.meta?.sessionName).toBe('Trimmed')
  expect(refreshDisk).toHaveBeenCalledWith('/w')

  vi.mocked(piCallOk).mockResolvedValue(false as never)
  refreshDisk.mockClear()
  await renameSidebarSession('/w', meta, 'Again', 's1')
  expect(refreshDisk).not.toHaveBeenCalled()
  await renameSidebarSession('/w', meta, '   ', 's1')
  expect(piCallOk).toHaveBeenCalledTimes(2)
})
