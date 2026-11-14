import { beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionSnapshot } from './connection'
import type { HostFrame, Receipt } from '@phosphor/shared/host-protocol'
import { HOST_TOO_OLD } from '@phosphor/shared/host-protocol-repositories'
import { laneArchives } from './lane-archive'

const id = '12345678-1234-4234-8234-123456789abc'
let view: HostConnectionSnapshot
let generation: number
const call = vi.fn<(...args: unknown[]) => Promise<Extract<HostFrame, { type: 'result' }>>>()
const send = vi.fn<(...args: unknown[]) => Promise<Receipt>>()
const connection = {
  snapshot: () => view,
  incarnation: () => ({ generation, runtimeEpoch: 'a'.repeat(16) }),
  call,
  send,
}
const archives = laneArchives(() => connection)
const inventory = { entries: [], bytes: null, measuredAt: null, measuring: false, truncated: false }
beforeEach(() => {
  generation = 1
  view = {
    connectionToken: 'test',
    state: 'ready',
    laneArchive: true,
    capabilities: ['sessions.read', 'sessions.control', 'workspaces.write'],
    repositories: [],
    lanes: [
      {
        laneId: id,
        repositoryId: 'a'.repeat(16),
        cwd: '/repo',
        title: 'Lane',
        branch: null,
        worktree: true,
        model: null,
        activity: 'stopped',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        attention: 0,
        read: 0,
        control: { fence: 3, controller: { clientId: id, label: 'Test', connected: true } },
      },
    ],
  }
  call.mockReset().mockResolvedValue({ type: 'result', id: 'list', ok: true, data: inventory })
  send.mockReset().mockResolvedValue({ status: 'done', requestId: id })
})
it('never falls back to Delete on a Host without recoverable archives', async () => {
  view.laneArchive = false
  await expect(archives.archive('host', id)).rejects.toThrow(HOST_TOO_OLD)
  await expect(archives.restore('host', id)).rejects.toThrow(HOST_TOO_OLD)
  expect(send).not.toHaveBeenCalled()
})
it('fences active archive, but restores and purges by machine-scoped archive identity', async () => {
  await archives.archive('host', id)
  expect(send).toHaveBeenLastCalledWith({ type: 'lane.archive', laneId: id }, id, 3)
  await archives.restore('host', id)
  expect(send).toHaveBeenLastCalledWith(
    { type: 'archive.restore', archiveId: id },
    undefined,
    undefined,
  )
  await archives.purge('host', id, true)
  expect(send).toHaveBeenLastCalledWith(
    { type: 'archive.purge', archiveId: id, removeWorktree: true },
    undefined,
    undefined,
  )
})
it('reads unknown storage as unknown and requires write authority only for mutations', async () => {
  view.capabilities = ['sessions.read']
  expect(await archives.list('host')).toEqual(inventory)
  expect(call).toHaveBeenCalledWith('archive.list', { measure: false })
  await expect(archives.purge('host', id, false)).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})
it('rejects replies from a replaced connection and malformed inventories', async () => {
  send.mockImplementationOnce(async () => {
    generation++
    return { status: 'done', requestId: id }
  })
  await expect(archives.restore('host', id)).rejects.toThrow()
  call.mockResolvedValueOnce({
    type: 'result',
    id: 'list',
    ok: true,
    data: { ...inventory, bytes: -1 },
  })
  await expect(archives.list('host')).rejects.toThrow('Invalid archive listing')
})
it('reports uncertain mutations without retry or legacy deletion', async () => {
  send.mockResolvedValueOnce({ status: 'unknown', requestId: id })
  await expect(archives.archive('host', id)).rejects.toThrow('did not confirm')
  expect(send).toHaveBeenCalledTimes(1)
})
