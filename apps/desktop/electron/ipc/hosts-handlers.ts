import { repositoryManagement } from '../hosts/repository-management'
import { repositoryReads } from '../hosts/repository-reads'
import { machineReads } from '../hosts/machine-reads'
import { uploadAttachments } from '../hosts/attachments'
import { handle, setRemoteReadRouter } from './handle'
import { REMOTE_UNAVAILABLE } from '../hosts/lane-ops'
import { trafficLog } from '../hosts/traffic-log'
import {
  createHostRuntime,
  installLifetime,
  clearHostRuntime,
  type HostRuntime,
} from '../hosts/runtime'
import { createHostIpcRouter } from '../hosts/ipc-router'

export function registerHostsHandlers(): void {
  const runtime = createHostRuntime()
  const window = installLifetime(runtime, clearHostRuntime)
  registerRepositories(runtime)
  registerCatalogues(runtime)
  setRemoteReadRouter(createHostIpcRouter(runtime))
  registerLanes(runtime, window)
  registerStatus(runtime)
}

function registerRepositories({ manager }: HostRuntime): void {
  const management = repositoryManagement(manager.connection)
  handle('hosts:listFolders', (_event, hostId, path, hidden) =>
    management.folders(hostId, path, hidden),
  )
  handle('hosts:createFolder', (_event, hostId, path) => management.createFolder(hostId, path))
  handle('hosts:addRepository', (_event, hostId, path) => management.add(hostId, path))
  handle('hosts:removeRepository', (_event, hostId, repositoryId) =>
    management.remove(hostId, repositoryId),
  )
  handle('hosts:deleteLane', (_event, hostId, laneId, options) =>
    management.deleteLane(hostId, laneId, options),
  )
  const repositories = repositoryReads(manager.connection)
  handle('hosts:repositoryFiles', (_event, hostId, repositoryId) =>
    repositories.list(hostId, repositoryId),
  )
  handle('hosts:repositoryFile', (_event, hostId, repositoryId, path) =>
    repositories.read(hostId, repositoryId, path),
  )
}

function registerCatalogues({ manager }: HostRuntime): void {
  const catalogues = machineReads(manager.connection)
  handle('hosts:models', (_event, hostId) => catalogues.models(hostId))
  handle('hosts:claude', (_event, hostId) => catalogues.claude(hostId))
  handle('hosts:providers', (_event, hostId) => catalogues.providers(hostId))
  handle('hosts:skills', (_event, hostId) => catalogues.skills(hostId))
}

function registerLanes(
  { remote, terminals }: HostRuntime,
  window: ReturnType<typeof installLifetime>,
): void {
  handle('hosts:openLane', (event, hostId, laneId) => remote.open(window(event), hostId, laneId))
  handle('hosts:createLane', (event, hostId, input) => remote.create(window(event), hostId, input))
  handle('hosts:stopLane', (_event, hostId, laneId) => remote.action(hostId, laneId, 'lane.stop'))
  handle('hosts:resumeLane', (_event, hostId, laneId) =>
    remote.action(hostId, laneId, 'lane.resume'),
  )
  handle('hosts:takeControl', (_event, hostId, laneId) =>
    remote.action(hostId, laneId, 'control.take'),
  )
  handle('hosts:releaseControl', (_event, hostId, laneId) =>
    remote.action(hostId, laneId, 'control.release'),
  )
  handle('hosts:markRead', (_event, hostId, laneId) =>
    remote.action(hostId, laneId, 'lane.markRead'),
  )
  handle('hosts:setFocusedLane', (event, target) => {
    window(event)
    remote.setFocused(event.sender.id, target)
  })
  handle('hosts:providerLogin', (event, hostId, provider) =>
    terminals.signIn(event.sender.id, hostId, provider),
  )
  handle('hosts:uploadAttachments', (event, sessionId, files) => {
    const lane = remote.readLane(event.sender.id, sessionId)
    if (!lane) throw new Error(REMOTE_UNAVAILABLE)
    return uploadAttachments(files, lane)
  })
}

function registerStatus({ manager }: HostRuntime): void {
  handle('hosts:snapshot', () => manager.snapshot())
  handle('hosts:reconnect', async (_event, hostId) => {
    if (typeof hostId !== 'string' || !manager.present(hostId)) return
    trafficLog.state(hostId, 'reconnect', 'requested')
    await manager.reconnect(hostId)
  })
  handle('hosts:traffic', (_event, after) =>
    trafficLog.read(typeof after === 'number' && Number.isFinite(after) ? after : 0),
  )
}
