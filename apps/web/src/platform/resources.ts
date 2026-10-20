import { machineReads } from '@phosphor/host-client/machine-reads'
import { repositoryReads } from '@phosphor/host-client/repository-reads'
import { repositoryManagement } from '@phosphor/host-client/repository-management'
import { readFeature } from '@phosphor/host-client/read-features'
import {
  createArtifactHost,
  remoteSessionArtifacts,
  remoteArtifactListings,
  remoteArtifactRead,
} from '@phosphor/host-client/artifacts'
import { createRemoteRoutines } from '@phosphor/host-client/routines'
import type { RemoteLanes } from '@phosphor/host-client/remote-lanes'
import type { IpcInvokeChannel } from '@phosphor/shared/ipc'
import type { RoutinesSnapshot } from '@phosphor/shared/routines'
import { isUuid } from '@phosphor/shared/control-api'
import { ARTIFACT_LIMITS, parseArtifactList } from '@phosphor/shared/host-protocol-artifacts'
import type { BrowserHosts } from './hosts'

export function createBrowserResources(hosts: BrowserHosts, lanes: RemoteLanes) {
  const machines = machineReads(hosts.connection)
  const routines = createRemoteRoutines({
    connection: hosts.connection,
    hosts: () => Object.keys(hosts.snapshot()),
    view: (id) => hosts.snapshot()[id],
    label: hosts.label,
  })
  function readLane(key: string) {
    const lane = lanes.readLane(1, key)
    if (!lane) throw new Error('Open and focus a remote lane first.')
    return lane
  }
  function artifactHosts(only?: string) {
    return Object.entries(hosts.snapshot())
      .filter(([id]) => only === undefined || id === only)
      .map(([id, view]) => {
        const connection = hosts.connection(id)
        if (!connection || view.state !== 'ready')
          throw new Error('Some machines are unavailable. Artifact listing is incomplete.')
        return view.capabilities.includes('artifacts.read')
          ? [createArtifactHost(id, hosts.label(id), connection, () => hosts.connection(id))]
          : []
      })
      .flat()
  }
  async function aggregateRoutines(): Promise<RoutinesSnapshot> {
    const result: RoutinesSnapshot = {
      routines: [],
      runs: [],
      background: false,
      error: hosts.directoryReady() ? null : 'Machine directory unavailable.',
      machines: routines.machines(),
    }
    // Sequential fanout bounds pressure; directory caps this at 32 Hosts.
    for (const [id, view] of Object.entries(hosts.snapshot())) {
      if (view.state !== 'ready') {
        result.error = 'Some machines are unavailable.'
        continue
      }
      if (!view.capabilities.includes('routines')) continue
      try {
        const snapshot = (await routines.route('routines:list', [`host:${id}`])
          ?.result) as RoutinesSnapshot
        if (!snapshot) throw new Error('Unavailable')
        result.routines.push(...snapshot.routines)
        if (result.routines.length > 3200) throw new Error('Routine list too large.')
      } catch {
        result.error = 'Some machine routines are unavailable.'
      }
    }
    return result
  }
  return {
    machines,
    repositories: repositoryReads(hosts.connection),
    folders: repositoryManagement(hosts.connection),
    clear: routines.clear,
    read(channel: IpcInvokeChannel, args: unknown[]) {
      const key = args[0]
      if (typeof key !== 'string') throw new Error('A remote resource key is required.')
      const machine = /^host:([^/]+)\/machine(?:\/|$)/.exec(key)
      if (machine) {
        if (!isUuid(machine[1]) || !['skills:list', 'skills:readFile'].includes(channel))
          throw new Error('Invalid remote resource.')
        return readFeature(channel, args, machines.lane(machine[1]))
      }
      return readFeature(channel, args, readLane(key))
    },
    sessionArtifacts: (key: string) => remoteSessionArtifacts(readLane(key)),
    async artifacts() {
      if (!hosts.directoryReady())
        throw new Error('Machine directory unavailable. Artifact listing is incomplete.')
      const rows = []
      // The shared aggregate intentionally tolerates offline Hosts for Desktop. Browser's
      // array-only contract cannot convey partial success, so validate each list first.
      for (const host of artifactHosts()) {
        const data = parseArtifactList(await host.call('artifacts.list', {}))
        if (!data) throw new Error('Artifact listing unavailable.')
        const snapshotHost = {
          ...host,
          call: async (method: string, params: unknown) =>
            method === 'artifacts.list' ? data : host.call(method, params),
        }
        const list = await remoteArtifactListings([snapshotHost])
        rows.push(...list)
        if (rows.length > ARTIFACT_LIMITS.count) throw new Error('Artifact listing too large.')
      }
      return rows
    },
    artifact: (key: string) => {
      const host = /^host:([^/]+)\//.exec(key)?.[1]
      if (!host || !isUuid(host)) throw new Error('Invalid artifact key.')
      return remoteArtifactRead(key, artifactHosts(host))
    },
    routine(channel: IpcInvokeChannel, args: unknown[]) {
      if (channel === 'routines:list' && args[0] === undefined) return aggregateRoutines()
      const routed = routines.route(channel, args)
      if (!routed) throw new Error('Select an enrolled Host. Local routines are unavailable.')
      return routed.result
    },
  }
}
