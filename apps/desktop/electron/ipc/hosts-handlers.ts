import { machineReads } from '../hosts/machine-reads'
import { routeRemoteWrite } from '../hosts/write-features'
import type { SessionPush } from '@shared/models'
import { app, BrowserWindow, Notification } from 'electron'
import { hostname } from 'node:os'
import { accountUserId, onAccountChange } from '../account'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { getRemoteClients, setRemoteClients } from '../store'
import { createClientIds } from '../hosts/client-id'
import { createGrants } from '../hosts/grants'
import { createHostConnection } from '../hosts/connection'
import { createHostManager } from '../hosts/manager'
import { e2eHostEndpoint, openHostSocket } from '../hosts/socket'
import { controlClient, onMachinesChanged } from './control-handlers'
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
import { createRemoteLanes, type RemoteLanes } from '../hosts/remote-lanes'
import { createRemoteTerminals } from '../hosts/terminals'
import { createRemoteRoutines } from '../hosts/routines'
import { createHostAttention } from '../hosts/attention'

let routines: ReturnType<typeof createRemoteRoutines> | undefined
export const remoteRoutineMachines = () => routines?.machines() ?? []
let remote: RemoteLanes | undefined
export function remoteLanes(): RemoteLanes {
  if (!remote) throw new Error('Remote lanes are not ready.')
  return remote
}

export function registerHostsHandlers(): void {
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
    changed: () => {
      remote?.reconcile()
      terminals?.reconcile()
      broadcast('hosts:changed', undefined)
    },
    connection: (hostId, endpoint) =>
      createHostConnection({
        hostId,
        endpoint,
        testEndpoint,
        socket: (url) => openHostSocket(url, log, testEndpoint),
        grant: () => grants.grantFor(hostId),
        clearGrant: () => grants.clear(hostId),
        changed: () => manager.changed(),
        disabled: () => manager.disabled(),
        onRoutinesChanged: () => broadcast('routines:changed', { machine: `host:${hostId}` }),
        onAttention: (event) => attention.receive(hostId, event),
        log,
      }),
  })
  const catalogues = machineReads(manager.connection)
  handle('hosts:models', (_event, hostId) => catalogues.models(hostId))
  handle('hosts:providers', (_event, hostId) => catalogues.providers(hostId))
  handle('hosts:skills', (_event, hostId) => catalogues.skills(hostId))
  remote = createRemoteLanes({
    connection: manager.connection,
    present: manager.present,
    label: manager.label,
    changed: manager.changed,
  })
  function artifactHosts(): ArtifactHost[] {
    return Object.entries(manager.snapshot()).flatMap(([hostId, view]) => {
      const c = manager.connection(hostId)
      if (!c || view.state !== 'ready' || !view.capabilities.includes('artifacts.read')) return []
      return [
        createArtifactHost(hostId, manager.label(hostId), c, () => manager.connection(hostId)),
      ]
    })
  }
  const terminals = createRemoteTerminals({
    connection: manager.connection,
    inputDropped: () => log('hosts', 'terminal_input_dropped'),
    lane: (windowId, sessionId, workspace) =>
      remoteLanes().terminalLane(windowId, sessionId, workspace),
    clientId: clients.current,
    emit: (windowId, channel, value) => {
      const sender = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.id === windowId,
      )?.webContents
      if (sender && !sender.isDestroyed()) sender.send(channel, value)
    },
  })
  routines = createRemoteRoutines({
    connection: manager.connection,
    hosts: () => Object.keys(manager.snapshot()),
    view: (host) => manager.snapshot()[host],
    label: manager.label,
  })
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
  const attention = createHostAttention({
    label: manager.label,
    focused: (hostId, laneId) =>
      BrowserWindow.getAllWindows().some(
        (win) => win.isFocused() && remoteLanes().focused(hostId, laneId, win.webContents.id),
      ),
    publish: (event) => broadcast('hosts:attention', event),
    notify: (title, body, click) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      notification.once('click', click)
      notification.show()
    },
    open: (hostId, laneId) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (win) {
        win.show()
        win.focus()
        win.webContents.send('hosts:openLaneRequested', { hostId, laneId })
      }
    },
  })
  let user = accountUserId()
  const off = onAccountChange(() => {
    const next = accountUserId()
    if (next !== user) {
      terminals?.clear()
      routines?.clear()
      remote?.clear()
      attention.clear()
      user = next
    }
  })
  const windows = new Set<number>()
  function window(event: Electron.IpcMainInvokeEvent) {
    const sender = event.sender
    if (!windows.has(sender.id)) {
      windows.add(sender.id)
      sender.once('destroyed', () => {
        terminals?.clear(sender.id)
        remote?.closeWindow(sender.id)
        windows.delete(sender.id)
      })
    }
    return {
      id: sender.id,
      send: (channel: string, push: SessionPush) => sender.send(channel, push),
      destroyed: () => sender.isDestroyed(),
    }
  }
  app.once('will-quit', () => {
    off()
    terminals?.clear()
    remote?.clear()
    routines = undefined
    manager.stop()
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
  handle('hosts:snapshot', () => manager.snapshot())
}
