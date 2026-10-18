import { app, BrowserWindow } from 'electron'
import { hostname } from 'node:os'
import { accountUserId, onAccountChange } from '../account'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { getRemoteClients, setRemoteClients } from '../store'
import { controlClient, onMachinesChanged } from '../control/runtime'
import { createClientIds } from './client-id'
import { createGrants } from './grants'
import { createHostConnection } from './connection'
import { createHostManager } from './manager'
import { e2eHostEndpoint, openHostSocket } from './socket'
import { createRemoteLanes, type RemoteLanes } from './remote-lanes'
import { createRemoteTerminals } from './terminals'
import { createRemoteRoutines } from './routines'
import { trafficLog } from './traffic-log'
import { tappedLog } from './traffic-tap'
import { initAttention, installLifetime } from './runtime-lifetime'

type ConnectionPorts = ReturnType<typeof initConnectionPorts>
type HostViews = ReturnType<typeof initViews>
export type HostRuntime = ConnectionPorts & HostViews
let current: HostRuntime | undefined
let routines: HostRuntime['routines'] | undefined
export const remoteRoutineMachines = () => routines?.machines() ?? []
export function clearHostRuntime(): void {
  routines = undefined
}
export function remoteLanes(): RemoteLanes {
  if (!current) throw new Error('Remote lanes are not ready.')
  return current.remote
}

export function createHostRuntime(): HostRuntime {
  const ports = initConnectionPorts(
    () => {
      views.remote.reconcile()
      views.terminals.reconcile()
      broadcast('hosts:changed', undefined)
    },
    (hostId, event) => views.attention.receive(hostId, event),
  )
  const views = initViews(ports)
  routines = views.routines
  current = { ...ports, ...views }
  return current
}

function initConnectionPorts(
  changed: () => void,
  receive: ReturnType<typeof initAttention>['receive'],
) {
  const testEndpoint = e2eHostEndpoint(process.env, app.isPackaged)
  const control = controlClient()
  const clients = createClientIds({
    user: accountUserId,
    read: getRemoteClients,
    write: setRemoteClients,
    hostname,
    control,
  })
  const grants = createGrants({ control, clients, present: (id) => manager.present(id) })
  const manager = createHostManager({
    testEndpoint,
    user: accountUserId,
    clientId: clients.current,
    resetReplacementBudget: clients.resetReplacementBudget,
    accountChanged: (cb) => onAccountChange(cb),
    machinesChanged: onMachinesChanged,
    machines: () => control.machines(),
    clearGrants: (id) => grants.clear(id),
    changed,
    connection: (hostId, endpoint) =>
      createHostConnection({
        hostId,
        endpoint,
        testEndpoint,
        socket: (url) => openHostSocket(url, tappedLog, testEndpoint),
        grant: () => grants.grantFor(hostId),
        clearGrant: () => grants.clear(hostId),
        changed: () => manager.changed(),
        disabled: () => manager.disabled(),
        onRoutinesChanged: () => broadcast('routines:changed', { machine: `host:${hostId}` }),
        onAttention: (event) => receive(hostId, event),
        log: tappedLog,
        traffic: (direction, frame, bytes) => trafficLog.frame(hostId, direction, frame, bytes),
      }),
  })
  return { clients, grants, manager }
}

function initViews({ clients, manager }: ConnectionPorts) {
  const remote = createRemoteLanes({
    connection: manager.connection,
    present: manager.present,
    label: manager.label,
    changed: manager.changed,
  })
  const terminals = createRemoteTerminals({
    connection: manager.connection,
    inputDropped: () => log('hosts', 'terminal_input_dropped'),
    lane: (windowId, sessionId, workspace) => remote.terminalLane(windowId, sessionId, workspace),
    clientId: clients.current,
    emit: (windowId, channel, value) => {
      const sender = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.id === windowId,
      )?.webContents
      if (sender && !sender.isDestroyed()) sender.send(channel, value)
    },
  })
  const routines = createRemoteRoutines({
    connection: manager.connection,
    hosts: () => Object.keys(manager.snapshot()),
    view: (host) => manager.snapshot()[host],
    label: manager.label,
  })
  const attention = initAttention(manager, remote)
  return { remote, terminals, routines, attention }
}

export { installLifetime }
