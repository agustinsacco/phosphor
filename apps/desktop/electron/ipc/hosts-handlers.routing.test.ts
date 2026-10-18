import { beforeEach, expect, it, vi } from 'vitest'
import type { IpcInvokeChannel } from '@shared/ipc'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  router: vi.fn(),
  readLane: vi.fn(),
  setFocused: vi.fn(),
  localList: vi.fn(),
  remoteList: vi.fn(),
  sessionArtifacts: vi.fn(),
  connection: vi.fn(),
}))
vi.mock('electron', () => ({ app: { once: vi.fn() }, BrowserWindow: {}, Notification: {} }))
vi.mock('../account', () => ({ accountUserId: vi.fn(), onAccountChange: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../store', () => ({ getRemoteClients: vi.fn(), setRemoteClients: vi.fn() }))
vi.mock('../hosts/client-id', () => ({ createClientIds: () => ({}) }))
vi.mock('../hosts/grants', () => ({ createGrants: () => ({}) }))
vi.mock('../hosts/connection', () => ({ createHostConnection: vi.fn() }))
vi.mock('../hosts/manager', () => ({
  createHostManager: () => ({ connection: state.connection, snapshot: () => ({}) }),
}))
vi.mock('../hosts/socket', () => ({ openHostSocket: vi.fn(), e2eHostEndpoint: vi.fn() }))
vi.mock('../control/runtime', () => ({ controlClient: () => ({}), onMachinesChanged: vi.fn() }))
vi.mock('./handle', () => ({
  handle: (name: string, cb: (...args: unknown[]) => unknown) => state.handlers.set(name, cb),
  setRemoteReadRouter: state.router,
}))
vi.mock('../hosts/remote-lanes', () => ({
  createRemoteLanes: () => ({ readLane: state.readLane, setFocused: state.setFocused }),
}))
vi.mock('../hosts/attention', () => ({ createHostAttention: () => ({}) }))
vi.mock('../hosts/artifacts', () => ({
  createArtifactHost: vi.fn(),
  remoteArtifactListings: state.remoteList,
  remoteArtifactRead: vi.fn(),
  remoteSessionArtifacts: state.sessionArtifacts,
}))
vi.mock('../artifacts/artifact-sync', () => ({ artifactLibrary: { list: state.localList } }))
import { registerHostsHandlers } from './hosts-handlers'

function route(windowId: number, channel: IpcInvokeChannel, args: unknown[]) {
  const router: unknown = state.router.mock.calls.at(-1)?.[0]
  if (typeof router !== 'function') throw new Error('Missing remote router')
  return router(windowId, channel, args)
}
function invoke(channel: string, ...args: unknown[]) {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`Missing ${channel}`)
  return handler(...args)
}
beforeEach(() => {
  vi.clearAllMocks()
  state.readLane.mockReturnValue(null)
  state.connection.mockReturnValue(undefined)
  registerHostsHandlers()
})
it('library keeps local rows on remote failure and appends remote rows after local rows', async () => {
  state.localList.mockResolvedValue(['local'])
  state.remoteList.mockRejectedValueOnce(new Error('offline'))
  expect(await route(7, 'artifacts:list', [['/local']]).result).toEqual(['local'])
  state.remoteList.mockResolvedValue(['remote'])
  expect(await route(7, 'artifacts:list', [['/local']]).result).toEqual(['local', 'remote'])
  expect(state.localList).toHaveBeenCalledWith(['/local'])
})
it('remote library validates every input before invoking either library', () => {
  for (const key of [
    undefined,
    '/local',
    [null],
    ['host:h/lane:l'],
    ['remote-handle'],
    Array(2001).fill('/local'),
  ]) {
    expect(() => route(7, 'artifacts:list', [key])).toThrow('Not available on remote lanes yet.')
  }
  expect(state.localList).not.toHaveBeenCalled()
  expect(state.remoteList).not.toHaveBeenCalled()
})
it('focused lane reads use sender authority while explicit local catalogue reads remain local', async () => {
  const key = 'host:h/lane:l'
  const call = vi.fn().mockResolvedValue({ files: ['README.md'] })
  state.readLane.mockReturnValue({
    workspacePath: key,
    laneId: '11111111-1111-4111-8111-111111111111',
    call,
  })
  expect(await route(7, 'fs:listFiles', [key]).result).toEqual(['README.md'])
  expect(state.readLane).toHaveBeenCalledWith(7, key)
  expect(call).toHaveBeenCalledWith('workspaces.read', 'files.list', {
    laneId: '11111111-1111-4111-8111-111111111111',
  })
  state.readLane.mockReturnValue(null)
  expect(() => route(8, 'fs:listFiles', [key])).toThrow('Not available on remote lanes yet.')
  expect(route(7, 'skills:list', ['/local'])).toBeNull()
  expect(route(7, 'skills:list', [])).toBeNull()
})
it('machine catalogue failure never asks the focused lane or falls through locally', async () => {
  expect(() => route(7, 'skills:list', ['host:h/machine'])).toThrow(
    'Not available on remote lanes yet.',
  )
  expect(state.readLane).not.toHaveBeenCalled()
  await expect(invoke('hosts:models', {}, 'h')).rejects.toThrow(
    'Not available on remote lanes yet.',
  )
  await expect(invoke('hosts:skills', {}, 'h')).rejects.toThrow(
    'Not available on remote lanes yet.',
  )
})
it('remote artifact session reads require an owned opaque handle', async () => {
  expect(() => route(7, 'artifacts:forSession', ['remote-handle'])).toThrow(
    'Not available on remote lanes yet.',
  )
  const lane = { workspacePath: 'host:h/lane:l' }
  state.readLane.mockReturnValue(lane)
  state.sessionArtifacts.mockResolvedValue(['artifact'])
  expect(await route(7, 'artifacts:forSession', ['remote-handle']).result).toEqual(['artifact'])
  expect(state.readLane).toHaveBeenLastCalledWith(7, 'remote-handle')
  expect(state.sessionArtifacts).toHaveBeenCalledWith(lane)
})
it('attachment ownership and upload errors are forwarded without changing sender identity', async () => {
  const event = { sender: { id: 7 } }
  expect(() => invoke('hosts:uploadAttachments', event, 'remote-handle', [])).toThrow(
    'Not available on remote lanes yet.',
  )
  expect(state.readLane).toHaveBeenCalledWith(7, 'remote-handle')
  const error = new Error('upload failed')
  const write = vi.fn().mockRejectedValue(error)
  state.readLane.mockReturnValue({ write })
  await expect(
    invoke('hosts:uploadAttachments', event, 'remote-handle', [
      { name: 'empty.pdf', mime: 'application/pdf', data: '' },
    ]),
  ).rejects.toBe(error)
})
