import type { IpcInvokeChannel } from '@shared/ipc'
import type { HostRuntime } from './runtime'
import { machineReads } from './machine-reads'
import { routeRemoteRead } from './read-features'
import { routeRemoteWrite } from './write-features'
import { REMOTE_UNAVAILABLE } from './lane-ops'
import {
  createArtifactHost,
  remoteSessionArtifacts,
  remoteArtifactListings,
  remoteArtifactRead,
  type ArtifactHost,
} from './artifacts'
import { artifactLibrary } from '../artifacts/artifact-sync'

type RemoteRoute = { result: Promise<unknown> } | null
export type HostIpcRuntime = {
  manager: Pick<HostRuntime['manager'], 'snapshot' | 'connection' | 'label'>
  remote: Pick<HostRuntime['remote'], 'readLane'>
  terminals: Pick<HostRuntime['terminals'], 'route'>
  routines: Pick<HostRuntime['routines'], 'route'>
}

export function createHostIpcRouter(runtime: HostIpcRuntime) {
  const { manager, remote, terminals, routines } = runtime
  const catalogues = machineReads(manager.connection)
  return (windowId: number, channel: IpcInvokeChannel, args: unknown[]): RemoteRoute => {
    const terminal = terminals.route(windowId, channel, args)
    if (terminal) return terminal
    const routine = routines.route(channel, args)
    if (routine) return routine
    const key = args[0]
    if (typeof key === 'string' && /^host:[^/]+\/machine(?:\/|$)/.test(key))
      return routeRemoteRead(channel, args, () => catalogues.lane(key.slice(5).split('/')[0] ?? ''))
    const artifact = routeArtifacts(runtime, windowId, channel, args)
    if (artifact) return artifact
    return (
      routeRemoteWrite(channel, args, (key) => remote.readLane(windowId, key)) ??
      routeRemoteRead(channel, args, (key) => remote.readLane(windowId, key))
    )
  }
}

function artifactHosts({ manager }: HostIpcRuntime): ArtifactHost[] {
  return Object.entries(manager.snapshot()).flatMap(([hostId, view]) => {
    const c = manager.connection(hostId)
    if (!c || view.state !== 'ready' || !view.capabilities.includes('artifacts.read')) return []
    return [createArtifactHost(hostId, manager.label(hostId), c, () => manager.connection(hostId))]
  })
}

function routeArtifacts(
  runtime: HostIpcRuntime,
  windowId: number,
  channel: IpcInvokeChannel,
  args: unknown[],
): RemoteRoute {
  const key = args[0]
  if (channel === 'artifacts:forSession' && typeof key === 'string' && key.startsWith('remote-')) {
    const lane = runtime.remote.readLane(windowId, key)
    if (!lane) throw new Error(REMOTE_UNAVAILABLE)
    return { result: remoteSessionArtifacts(lane) }
  }
  if (channel === 'artifacts:read' && typeof key === 'string' && key.startsWith('host:'))
    return { result: remoteArtifactRead(key, artifactHosts(runtime)) }
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
        remoteArtifactListings(artifactHosts(runtime)).catch(() => []),
      ]).then(([local, remote]) => [...local, ...remote]),
    }
  }
  return null
}
