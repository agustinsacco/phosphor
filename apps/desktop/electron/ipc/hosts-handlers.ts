import { repositoryManagement } from '../hosts/repository-management'
import { repositoryReads } from '../hosts/repository-reads'
import { machineReads } from '../hosts/machine-reads'
import { uploadAttachments } from '../hosts/attachments'
import { routeRemoteWrite } from '../hosts/write-features'
import { handle, setRemoteReadRouter } from './handle'
import {
  createArtifactHost,
  remoteSessionArtifacts,
  remoteArtifactListings,
  remoteArtifactRead,
  type ArtifactHost,
} from '../hosts/artifacts'
import { artifactLibrary } from '../artifacts/artifact-sync'
import { REMOTE_UNAVAILABLE } from '../hosts/lane-ops'
import { routeRemoteRead } from '../hosts/read-features'
import { trafficLog } from '../hosts/traffic-log'
import { createHostRuntime, installLifetime, clearHostRuntime, remoteLanes } from '../hosts/runtime'
export { remoteLanes, remoteRoutineMachines } from '../hosts/runtime'

export function registerHostsHandlers(): void {
  const runtime = createHostRuntime()
  const { manager, terminals, routines } = runtime
  const window = installLifetime(runtime, clearHostRuntime)
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
  const catalogues = machineReads(manager.connection)
  handle('hosts:models', (_event, hostId) => catalogues.models(hostId))
  handle('hosts:claude', (_event, hostId) => catalogues.claude(hostId))
  handle('hosts:providers', (_event, hostId) => catalogues.providers(hostId))
  handle('hosts:skills', (_event, hostId) => catalogues.skills(hostId))
  function artifactHosts(): ArtifactHost[] {
    return Object.entries(manager.snapshot()).flatMap(([hostId, view]) => {
      const c = manager.connection(hostId)
      if (!c || view.state !== 'ready' || !view.capabilities.includes('artifacts.read')) return []
      return [
        createArtifactHost(hostId, manager.label(hostId), c, () => manager.connection(hostId)),
      ]
    })
  }
  setRemoteReadRouter((windowId, channel, args) => {
    const terminal = terminals.route(windowId, channel, args)
    if (terminal) return terminal
    const routine = routines?.route(channel, args)
    if (routine) return routine
    const key = args[0]
    if (typeof key === 'string' && /^host:[^/]+\/machine(?:\/|$)/.test(key))
      return routeRemoteRead(channel, args, () => catalogues.lane(key.slice(5).split('/')[0] ?? ''))
    if (
      channel === 'artifacts:forSession' &&
      typeof key === 'string' &&
      key.startsWith('remote-')
    ) {
      const lane = remoteLanes().readLane(windowId, key)
      if (!lane) throw new Error(REMOTE_UNAVAILABLE)
      return { result: remoteSessionArtifacts(lane) }
    }
    if (channel === 'artifacts:read' && typeof key === 'string' && key.startsWith('host:'))
      return { result: remoteArtifactRead(key, artifactHosts()) }
    if (channel === 'artifacts:list') {
      if (
        !Array.isArray(key) ||
        key.length > 2000 ||
        key.some((p) => typeof p !== 'string' || p.startsWith('host:') || p.startsWith('remote-'))
      )
        throw new Error(REMOTE_UNAVAILABLE)
      return {
        result: Promise.all([
          artifactLibrary.list(key),
          remoteArtifactListings(artifactHosts()).catch(() => []),
        ]).then(([local, remote]) => [...local, ...remote]),
      }
    }
    return (
      routeRemoteWrite(channel, args, (key) => remoteLanes().readLane(windowId, key)) ??
      routeRemoteRead(channel, args, (key) => remoteLanes().readLane(windowId, key))
    )
  })
  handle('hosts:openLane', (event, hostId, laneId) =>
    remoteLanes().open(window(event), hostId, laneId),
  )
  handle('hosts:createLane', (event, hostId, input) =>
    remoteLanes().create(window(event), hostId, input),
  )
  handle('hosts:stopLane', (_event, hostId, laneId) =>
    remoteLanes().action(hostId, laneId, 'lane.stop'),
  )
  handle('hosts:resumeLane', (_event, hostId, laneId) =>
    remoteLanes().action(hostId, laneId, 'lane.resume'),
  )
  handle('hosts:takeControl', (_event, hostId, laneId) =>
    remoteLanes().action(hostId, laneId, 'control.take'),
  )
  handle('hosts:releaseControl', (_event, hostId, laneId) =>
    remoteLanes().action(hostId, laneId, 'control.release'),
  )
  handle('hosts:markRead', (_event, hostId, laneId) =>
    remoteLanes().action(hostId, laneId, 'lane.markRead'),
  )
  handle('hosts:setFocusedLane', (event, target) => {
    window(event)
    remoteLanes().setFocused(event.sender.id, target)
  })
  handle('hosts:providerLogin', (event, hostId, provider) =>
    terminals.signIn(event.sender.id, hostId, provider),
  )
  handle('hosts:uploadAttachments', (event, sessionId, files) => {
    const lane = remoteLanes().readLane(event.sender.id, sessionId)
    if (!lane) throw new Error(REMOTE_UNAVAILABLE)
    return uploadAttachments(files, lane)
  })
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
