import { expect, it, vi } from 'vitest'
import type { ArtifactListing } from '@shared/artifacts'

const mocks = vi.hoisted(() => ({
  router: vi.fn(),
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
vi.mock('../hosts/socket', () => ({ openHostSocket: vi.fn() }))
vi.mock('./control-handlers', () => ({ controlClient: () => ({}), onMachinesChanged: vi.fn() }))
vi.mock('./handle', () => ({ handle: vi.fn(), setRemoteReadRouter: mocks.router }))
vi.mock('../hosts/artifacts', () => ({
  createArtifactHost: vi.fn(),
  remoteSessionArtifacts: vi.fn(),
  remoteArtifactListings: mocks.remoteList,
  remoteArtifactRead: vi.fn(),
}))
vi.mock('../artifacts/artifact-sync', () => ({ artifactLibrary: { list: mocks.localList } }))
vi.mock('../hosts/read-features', () => ({ routeRemoteRead: vi.fn() }))
vi.mock('../hosts/remote-lanes', () => ({ createRemoteLanes: () => ({}) }))
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
