import { expect, it, vi } from 'vitest'
import type { ArtifactListing } from '@shared/artifacts'

const mocks = vi.hoisted(() => ({
  router: vi.fn(),
  handle: vi.fn(),
  readLane: vi.fn(),
  localList: vi.fn(),
  remoteList: vi.fn(),
  connection: vi.fn(),
}))
vi.mock('electron', () => ({ app: { once: vi.fn() }, BrowserWindow: {}, Notification: {} }))
vi.mock('../account', () => ({ accountUserId: vi.fn(), onAccountChange: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../store', () => ({
  getRemoteClients: vi.fn(),
  setRemoteClients: vi.fn(),
  getConfigureHosts: vi.fn(),
  setConfigureHosts: vi.fn(),
}))
vi.mock('../hosts/client-id', () => ({ createClientIds: () => ({}) }))
vi.mock('../hosts/grants', () => ({ createGrants: () => ({}) }))
vi.mock('../hosts/connection', () => ({ createHostConnection: vi.fn() }))
vi.mock('../hosts/manager', () => ({
  createHostManager: () => ({ snapshot: () => ({}), connection: mocks.connection }),
}))
vi.mock('../hosts/socket', () => ({
  openHostSocket: vi.fn(),
  e2eHostEndpoint: () => undefined,
}))
vi.mock('./control-handlers', () => ({ controlClient: () => ({}), onMachinesChanged: vi.fn() }))
vi.mock('./handle', () => ({ handle: mocks.handle, setRemoteReadRouter: mocks.router }))
vi.mock('@phosphor/host-client/artifacts', () => ({
  createArtifactHost: vi.fn(),
  remoteSessionArtifacts: vi.fn(),
  remoteArtifactListings: mocks.remoteList,
  remoteArtifactRead: vi.fn(),
}))
vi.mock('../artifacts/artifact-sync', () => ({ artifactLibrary: { list: mocks.localList } }))
vi.mock('@phosphor/host-client/read-features', () => ({ routeRemoteRead: vi.fn() }))
vi.mock('../hosts/remote-lanes', () => ({
  createRemoteLanes: () => ({ readLane: mocks.readLane }),
}))
vi.mock('../hosts/attention', () => ({ createHostAttention: () => ({}) }))

import { registerHostsHandlers } from './hosts-handlers'

it('library loads local rows even when the remote listing rejects', async () => {
  const local: ArtifactListing = {
    key: 'local',
    sessionId: 'local',
    id: 'guide',
    sessionFile: '/local/session',
    cwd: '/local',
    title: 'Guide',
    type: 'html',
    version: 1,
    versionCount: 1,
    updatedAt: 0,
    revision: '1',
    sessionDeleted: false,
    workspaceExists: true,
  }
  mocks.localList.mockResolvedValue([local])
  mocks.remoteList.mockRejectedValue(new Error('unavailable'))
  registerHostsHandlers()
  const router: unknown = mocks.router.mock.calls[0]?.[0]
  if (typeof router !== 'function') throw new Error('Missing router')
  expect(await router(1, 'artifacts:list', [['/local']]).result).toEqual([local])
  expect(mocks.localList).toHaveBeenCalledWith(['/local'])
})

it('attachment IPC resolves only the owning opaque lane and fails closed without one', async () => {
  mocks.handle.mockClear()
  registerHostsHandlers()
  const handler: unknown = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'hosts:uploadAttachments',
  )?.[1]
  if (typeof handler !== 'function') throw new Error('Missing attachment handler')
  mocks.readLane.mockReturnValue(null)
  expect(() => handler({ sender: { id: 7 } }, 'remote-handle', [])).toThrow()
  expect(mocks.readLane).toHaveBeenCalledWith(7, 'remote-handle')
  const write = vi.fn(async (op) =>
    op.type === 'attachments.begin'
      ? { uploadId: 'a'.repeat(32) }
      : { path: '/host/attachments/a.pdf' },
  )
  mocks.readLane.mockReturnValue({ write })
  expect(
    await handler({ sender: { id: 7 } }, 'remote-handle', [
      { name: 'empty.pdf', mime: 'application/pdf', data: '' },
    ]),
  ).toEqual(['/host/attachments/a.pdf'])
  expect(write).toHaveBeenCalledTimes(2)
})

it('does not deny explicit Mac catalogue reads because a remote lane is focused', () => {
  mocks.readLane.mockReturnValue({ workspacePath: 'host:h/lane:l', call: vi.fn() })
  registerHostsHandlers()
  const router: unknown = mocks.router.mock.calls.at(-1)?.[0]
  if (typeof router !== 'function') throw new Error('Missing router')
  for (const channel of ['fs:readFile', 'fs:listFiles', 'fs:readDir'])
    expect(router(7, channel, ['/Mac/catalogue'])).toBeFalsy()
})

it('sets Host lane marks over the shared host-client module, unfenced', async () => {
  const laneId = '12345678-1234-4234-8234-123456789abc'
  mocks.handle.mockClear()
  registerHostsHandlers()
  const handler: unknown = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'hosts:setLaneMarks',
  )?.[1]
  expect(typeof handler).toBe('function')
  const send = vi.fn(async () => ({ requestId: laneId, status: 'done' }))
  const view = {
    state: 'ready',
    capabilities: ['sessions.read', 'sessions.control'],
    lanes: [{ laneId, control: { fence: 2, controller: null } }],
  }
  const connection = { snapshot: () => view, incarnation: () => ({ generation: 1 }), send }
  mocks.connection.mockImplementation((hostId: string) => (hostId === 'h' ? connection : undefined))
  if (typeof handler !== 'function') return
  await handler({ sender: { id: 7 } }, 'h', laneId, { marker: '🦊' })
  expect(send).toHaveBeenCalledWith({ type: 'lane.marks', marker: '🦊' }, laneId)
  await expect(handler({ sender: { id: 7 } }, 'other', laneId, { pinned: true })).rejects.toThrow()
})

it('forwards targeted PR options through the opaque remote repository router', async () => {
  const hostId = '00000000-0000-4000-8000-000000000001'
  const repositoryId = '1234567890abcdef'
  const options = { branches: ['feature'], force: true }
  const call = vi.fn(async () => ({
    type: 'result',
    id: 'pr',
    ok: true,
    data: {
      byBranch: {},
      complete: false,
      coverage: {
        feature: { state: 'absent', checkedAt: 10, attemptedAt: 10 },
      },
    },
  }))
  const connection = {
    snapshot: () => ({
      state: 'ready',
      capabilities: ['workspaces.read'],
      repositories: [{ id: repositoryId }],
    }),
    incarnation: () => ({ generation: 1 }),
    call,
  }
  mocks.connection.mockReturnValue(connection)
  registerHostsHandlers()
  const router: unknown = mocks.router.mock.calls.at(-1)?.[0]
  if (typeof router !== 'function') throw new Error('Missing router')
  const key = `host:${hostId}/repo:${repositoryId}`
  expect(await router(1, 'gh:prsForRepo', [key, options]).result).toMatchObject({
    coverage: { feature: { state: 'absent' } },
  })
  expect(call).toHaveBeenCalledExactlyOnceWith('github.prs', { repositoryId, options })
})

it('routes PR status and detail that name a Host machine to it, and leaves This Mac its own', async () => {
  const hostId = '00000000-0000-4000-8000-000000000001'
  const ref = { host: 'github.com', owner: 'acme', repo: 'app', number: 57 }
  const call = vi.fn(async () => ({ type: 'result', id: 'pr', ok: true, data: null }))
  const connection = {
    snapshot: () => ({ state: 'ready', prStatus: true, capabilities: ['workspaces.read'] }),
    incarnation: () => ({ generation: 1 }),
    call,
  }
  mocks.connection.mockReturnValue(connection)
  registerHostsHandlers()
  const router: unknown = mocks.router.mock.calls.at(-1)?.[0]
  if (typeof router !== 'function') throw new Error('Missing router')
  expect(await router(1, 'gh:prSummaries', [[ref], undefined, `host:${hostId}`]).result).toBeNull()
  expect(call).toHaveBeenLastCalledWith('github.prSummaries', { refs: [ref], options: {} })
  expect(await router(1, 'gh:prDetail', [ref, { force: true }, `host:${hostId}`]).result).toBeNull()
  expect(call).toHaveBeenLastCalledWith('github.prDetail', { ref, options: { force: true } })
  expect(router(1, 'gh:prSummaries', [[ref]])).toBeFalsy()
  expect(router(1, 'gh:prDetail', [ref, undefined])).toBeFalsy()
})

it('registers the Host catalogue and repository reads over the manager connection', async () => {
  const hostId = '00000000-0000-4000-8000-000000000001'
  const repositoryId = '1234567890abcdef'
  mocks.handle.mockClear()
  registerHostsHandlers()
  const channels = mocks.handle.mock.calls.map(([channel]) => channel)
  for (const channel of [
    'hosts:models',
    'hosts:claude',
    'hosts:claudeUsage',
    'hosts:providers',
    'hosts:skills',
    'hosts:repositoryFiles',
    'hosts:repositoryFile',
  ])
    expect(channels).toContain(channel)
  const handler: unknown = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'hosts:repositoryFiles',
  )?.[1]
  if (typeof handler !== 'function') throw new Error('Missing repository files handler')
  const call = vi.fn(async () => ({ type: 'result', id: 'f', ok: true, data: { files: ['a.ts'] } }))
  mocks.connection.mockReturnValue({
    snapshot: () => ({
      state: 'ready',
      capabilities: ['workspaces.read'],
      repositories: [{ id: repositoryId }],
    }),
    incarnation: () => ({ generation: 1 }),
    call,
  })
  await handler({ sender: { id: 7 } }, hostId, repositoryId).catch(() => undefined)
  expect(call).toHaveBeenCalledWith('files.list', expect.objectContaining({ repositoryId }))
})
