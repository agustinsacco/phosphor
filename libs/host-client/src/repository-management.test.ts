import { beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionSnapshot } from './connection'
import type { HostFrame, Receipt } from '@phosphor/shared/host-protocol'
import { repositoryManagement } from './repository-management'
import { FOLDER_EXISTS, HOST_TOO_OLD } from '@phosphor/shared/host-protocol-repositories'
const laneId = '12345678-1234-4234-8234-123456789abc'
let view: HostConnectionSnapshot, generation: number
const call = vi.fn<(...args: unknown[]) => Promise<Extract<HostFrame, { type: 'result' }>>>()
const send = vi.fn<(...args: unknown[]) => Promise<Receipt>>()
const c = {
  snapshot: () => view,
  incarnation: () => ({ generation, runtimeEpoch: '0000000000000001' }),
  call,
  send,
}
let connected: typeof c | undefined
const management = repositoryManagement(() => connected)
beforeEach(() => {
  connected = c
  generation = 1
  view = {
    connectionToken: 'test',
    state: 'ready',
    capabilities: ['workspaces.write', 'sessions.control'],
    repositories: [],
    lanes: [],
  }
  call.mockReset().mockResolvedValue({
    type: 'result',
    id: 'folders',
    ok: true,
    data: { path: '', truncated: false, entries: [] },
  })
  send.mockReset().mockResolvedValue({
    requestId: laneId,
    status: 'done',
    data: { id: '1234567890abcdef', path: '/must-not-cross' },
  })
})
it('reads machine folders and returns only the new repository identity', async () => {
  expect(await management.folders('host')).toEqual({ path: '', truncated: false, entries: [] })
  expect(call).toHaveBeenCalledWith('machine.folders.list', {})
  expect(await management.add('host', 'Projects')).toEqual({ repositoryId: '1234567890abcdef' })
  await management.remove('host', '1234567890abcdef')
})
it('asks for hidden folders only when wanted, since older Hosts refuse the key', async () => {
  await management.folders('host', 'src', false)
  expect(call).toHaveBeenLastCalledWith('machine.folders.list', { path: 'src' })
  await management.folders('host', '.config', true)
  expect(call).toHaveBeenLastCalledWith('machine.folders.list', { path: '.config', hidden: true })
})
it('creates a folder and names the two refusals a user can act on', async () => {
  await management.createFolder('host', 'src/new')
  expect(send).toHaveBeenLastCalledWith(
    { type: 'host.repositories.createFolder', path: 'src/new' },
    undefined,
    undefined,
  )
  send.mockResolvedValueOnce({ requestId: laneId, status: 'rejected', code: 'conflict' })
  await expect(management.createFolder('host', 'src/new')).rejects.toThrow(FOLDER_EXISTS)
  send.mockResolvedValueOnce({ requestId: laneId, status: 'rejected', code: 'unsupported' })
  await expect(management.createFolder('host', 'src/new')).rejects.toThrow(HOST_TOO_OLD)
  send.mockClear()
  await expect(management.createFolder('host', 'src/..')).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})
it.each(['capability', 'connection', 'generation', 'ready'] as const)(
  'rechecks %s for queries and mutations',
  async (change) => {
    const invalidate = () => {
      if (change === 'capability') view.capabilities = []
      if (change === 'connection') connected = { ...c }
      if (change === 'generation') generation++
      if (change === 'ready') view.state = 'down'
    }
    call.mockImplementation(async () => {
      invalidate()
      return {
        type: 'result',
        id: 'folders',
        ok: true,
        data: { path: '', truncated: false, entries: [] },
      }
    })
    await expect(management.folders('host')).rejects.toThrow()
    connected = c
    generation = 1
    view.state = 'ready'
    view.capabilities = ['workspaces.write', 'sessions.control']
    send.mockImplementation(async () => {
      invalidate()
      return { requestId: laneId, status: 'done', data: { id: '1234567890abcdef' } }
    })
    await expect(management.add('host', 'Projects')).rejects.toThrow()
  },
)
it('refuses malformed responses, unsafe input, missing capabilities and unknown lanes', async () => {
  await expect(management.folders('host', '../escape')).rejects.toThrow()
  await expect(
    management.deleteLane('host', laneId, { removeWorktree: true, removeBranch: true }),
  ).rejects.toThrow()
  call.mockResolvedValueOnce({
    type: 'result',
    id: 'folders',
    ok: true,
    data: { path: '/private', truncated: false, entries: [] },
  })
  await expect(management.folders('host')).rejects.toThrow()
  view.capabilities = []
  await expect(management.add('host', 'Projects')).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})

it.each([true, false])('parses branchKept=%s from deletion receipts', async (branchKept) => {
  view.lanes = [
    {
      laneId,
      repositoryId: '1234567890abcdef',
      cwd: '/repo',
      worktree: false,
      title: null,
      branch: null,
      model: null,
      activity: 'idle',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      attention: 0,
      read: 0,
      control: { fence: 1, controller: null },
    },
  ]
  send.mockResolvedValue({ requestId: laneId, status: 'done', data: { branchKept } })
  expect(
    await management.deleteLane('host', laneId, { removeWorktree: false, removeBranch: true }),
  ).toEqual({ branchKept })
  for (const data of [undefined, {}, { branchKept: 1 }, { branchKept: false, extra: true }]) {
    send.mockResolvedValue({ requestId: laneId, status: 'done', data })
    await expect(
      management.deleteLane('host', laneId, { removeWorktree: false, removeBranch: true }),
    ).rejects.toThrow('outcome is unknown')
  }
})
