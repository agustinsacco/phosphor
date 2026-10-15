import { expect, it, vi } from 'vitest'
import type { ArtifactListing } from '@shared/artifacts'

const mocks = vi.hoisted(() => ({
  router: vi.fn(),
  handle: vi.fn(),
  readLane: vi.fn(),
  localList: vi.fn(),
  remoteList: vi.fn(),
}))
vi.mock('electron', () => ({ app: { once: vi.fn() }, BrowserWindow: {}, Notification: {} }))
vi.mock('../account', () => ({ accountUserId: vi.fn(), onAccountChange: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../store', () => ({ getRemoteClients: vi.fn(), setRemoteClients: vi.fn() }))
vi.mock('../hosts/client-id', () => ({ createClientIds: () => ({}) }))
vi.mock('../hosts/grants', () => ({ createGrants: () => ({}) }))
vi.mock('../hosts/connection', () => ({ createHostConnection: vi.fn() }))
vi.mock('../hosts/manager', () => ({ createHostManager: () => ({ snapshot: () => ({}) }) }))
vi.mock('../hosts/socket', () => ({
  openHostSocket: vi.fn(),
  e2eHostEndpoint: () => undefined,
}))
vi.mock('./control-handlers', () => ({ controlClient: () => ({}), onMachinesChanged: vi.fn() }))
vi.mock('./handle', () => ({ handle: mocks.handle, setRemoteReadRouter: mocks.router }))
vi.mock('../hosts/artifacts', () => ({
  createArtifactHost: vi.fn(),
  remoteSessionArtifacts: vi.fn(),
  remoteArtifactListings: mocks.remoteList,
  remoteArtifactRead: vi.fn(),
}))
vi.mock('../artifacts/artifact-sync', () => ({ artifactLibrary: { list: mocks.localList } }))
vi.mock('../hosts/read-features', () => ({ routeRemoteRead: vi.fn() }))
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
