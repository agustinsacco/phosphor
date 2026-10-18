import { beforeEach, expect, it, vi } from 'vitest'
import type { HostFrame, LaneSummary, Receipt } from '@shared/host-protocol'
import { FOLDER_EXISTS, HOST_TOO_OLD } from '@shared/host-protocol-repositories'
import type { HostConnectionSnapshot } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'
import { repositoryManagement } from './repository-management'

const laneId = '12345678-1234-4234-8234-123456789abc'
const folders = { path: '', truncated: false, entries: [] }
const lane: LaneSummary = {
  laneId,
  repositoryId: '1234567890abcdef',
  cwd: '/private/repo',
  worktree: false,
  title: null,
  branch: null,
  model: null,
  activity: 'idle',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  attention: 0,
  read: 0,
  control: { fence: 7, controller: null },
}
let view: HostConnectionSnapshot
let generation: number
const call = vi.fn<(...args: unknown[]) => Promise<Extract<HostFrame, { type: 'result' }>>>()
const send = vi.fn<(...args: unknown[]) => Promise<Receipt>>()
const connection = {
  snapshot: () => view,
  incarnation: () => ({ generation, runtimeEpoch: '0000000000000001' }),
  call,
  send,
}
let current: typeof connection | undefined
const management = repositoryManagement(() => current)

beforeEach(() => {
  current = connection
  generation = 1
  view = {
    connectionToken: 'test',
    state: 'ready',
    capabilities: ['workspaces.write', 'sessions.control'],
    repositories: [],
    lanes: [lane],
  }
  call.mockReset().mockResolvedValue({ type: 'result', id: 'folders', ok: true, data: folders })
  send.mockReset().mockResolvedValue({
    requestId: laneId,
    status: 'done',
    data: { id: lane.repositoryId, path: '/private/repo' },
  })
})

function invalidate(change: string) {
  if (change === 'missing') current = undefined
  if (change === 'replacement') current = { ...connection }
  if (change === 'generation') generation++
  if (change === 'ready') view.state = 'down'
  if (change === 'write') view.capabilities = ['sessions.control']
  if (change === 'control') view.capabilities = ['workspaces.write']
}

it.each(['missing', 'ready', 'write', 'control'])(
  'checks %s admission before sending repository operations',
  async (change) => {
    invalidate(change)
    if (change === 'control') {
      await expect(management.folders('host')).resolves.toEqual(folders)
    } else {
      await expect(management.folders('host')).rejects.toThrow(REMOTE_UNAVAILABLE)
      expect(call).not.toHaveBeenCalled()
    }
    await expect(management.add('host', 'Projects')).rejects.toThrow(REMOTE_UNAVAILABLE)
    expect(send).not.toHaveBeenCalled()
  },
)

it.each(['missing', 'replacement', 'generation', 'ready', 'write'])(
  'refuses folder replies after %s changes during the await',
  async (change) => {
    call.mockImplementationOnce(async () => {
      invalidate(change)
      return { type: 'result', id: 'folders', ok: true, data: folders }
    })
    await expect(management.folders('host')).rejects.toThrow(REMOTE_UNAVAILABLE)
    expect(call).toHaveBeenCalledOnce()
  },
)

it.each(['missing', 'replacement', 'generation', 'ready', 'write', 'control'])(
  'refuses mutation receipts after %s changes during the await',
  async (change) => {
    send.mockImplementationOnce(async () => {
      invalidate(change)
      return { requestId: laneId, status: 'done', data: { id: lane.repositoryId } }
    })
    await expect(management.add('host', 'Projects')).rejects.toThrow(REMOTE_UNAVAILABLE)
    expect(send).toHaveBeenCalledOnce()
  },
)

it('binds lane deletion to the current fence and refuses an unknown lane', async () => {
  send.mockResolvedValue({ requestId: laneId, status: 'done', data: { branchKept: true } })
  const options = { removeWorktree: false, removeBranch: true }
  await expect(management.deleteLane('host', laneId, options)).resolves.toEqual({
    branchKept: true,
  })
  expect(send).toHaveBeenCalledWith({ type: 'lane.delete', laneId, ...options }, laneId, 7)
  send.mockClear()
  view.lanes = []
  await expect(management.deleteLane('host', laneId, options)).rejects.toThrow(REMOTE_UNAVAILABLE)
  expect(send).not.toHaveBeenCalled()
})

it('omits hidden unless requested and exposes only the repository identity', async () => {
  await management.folders('host', 'src', false)
  expect(call).toHaveBeenLastCalledWith('machine.folders.list', { path: 'src' })
  await management.folders('host', '.config', true)
  expect(call).toHaveBeenLastCalledWith('machine.folders.list', { path: '.config', hidden: true })
  await expect(management.add('host', 'Projects')).resolves.toEqual({
    repositoryId: lane.repositoryId,
  })
})

it('refuses unsafe paths, invalid identities and malformed folder replies', async () => {
  await expect(management.folders('host', '../escape')).rejects.toThrow(REMOTE_UNAVAILABLE)
  await expect(management.add('host', '/private/repo')).rejects.toThrow(REMOTE_UNAVAILABLE)
  await expect(management.createFolder('host', 'src/..')).rejects.toThrow(REMOTE_UNAVAILABLE)
  await expect(management.remove('host', 'invalid')).rejects.toThrow(REMOTE_UNAVAILABLE)
  expect(call).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  call.mockResolvedValueOnce({
    type: 'result',
    id: 'folders',
    ok: true,
    data: { ...folders, path: '/private/repo' },
  })
  await expect(management.folders('host')).rejects.toThrow(REMOTE_UNAVAILABLE)
  send.mockResolvedValueOnce({ requestId: laneId, status: 'done', data: { id: '/private/repo' } })
  await expect(management.add('host', 'Projects')).rejects.toThrow(REMOTE_UNAVAILABLE)
})

it.each([
  ['last-repository', 'A machine needs at least one folder. Add another first.'],
  ['unsupported', HOST_TOO_OLD],
  ['conflict', 'The remote change was not confirmed.'],
] as const)('maps %s refusals without exposing peer details', async (code, message) => {
  send.mockResolvedValueOnce({ requestId: laneId, status: 'rejected', code })
  await expect(management.remove('host', lane.repositoryId)).rejects.toThrow(message)
})

it('maps create-folder conflict and refuses an unconfirmed mutation', async () => {
  send.mockResolvedValueOnce({ requestId: laneId, status: 'rejected', code: 'conflict' })
  await expect(management.createFolder('host', 'src/new')).rejects.toThrow(FOLDER_EXISTS)
  send.mockResolvedValueOnce({ requestId: laneId, status: 'unknown' })
  await expect(management.createFolder('host', 'src/new')).rejects.toThrow(
    'The remote change was not confirmed.',
  )
})

it.each([undefined, {}, { branchKept: 1 }, { branchKept: false, path: '/private/repo' }])(
  'refuses unknown deletion outcomes: %j',
  async (data) => {
    send.mockResolvedValueOnce({ requestId: laneId, status: 'done', data })
    await expect(
      management.deleteLane('host', laneId, { removeWorktree: true, removeBranch: true }),
    ).rejects.toThrow('Remote deletion outcome is unknown.')
  },
)
