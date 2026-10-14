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
import { openHostSocket } from '../hosts/socket'
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
import { createHostAttention } from '../hosts/attention'

let remote: RemoteLanes | undefined
export function remoteLanes(): RemoteLanes {
  if (!remote) throw new Error('Remote lanes are not ready.')
  return remote
}

export function registerHostsHandlers(): void {
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
    user: accountUserId,
    clientId: clients.current,
    resetReplacementBudget: clients.resetReplacementBudget,
    accountChanged: (cb) => onAccountChange(cb),
    machinesChanged: onMachinesChanged,
    machines: () => control.machines(),
    clearGrants: (id) => grants.clear(id),
    changed: () => {
      remote?.reconcile()
      broadcast('hosts:changed', undefined)
    },
    connection: (hostId, endpoint) =>
      createHostConnection({
        hostId,
        endpoint,
        socket: (url) => openHostSocket(url, log),
        grant: () => grants.grantFor(hostId),
        clearGrant: () => grants.clear(hostId),
        changed: () => manager.changed(),
        disabled: () => manager.disabled(),
        onAttention: (event) => attention.receive(hostId, event),
        log,
      }),
  })
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
  setRemoteReadRouter((windowId, channel, args) => {
    const key = args[0]
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
          remoteArtifactListings(artifactHosts()),
        ]).then(([local, remote]) => [...local, ...remote]),
      }
    }
    return routeRemoteRead(channel, args, (key) => remoteLanes().readLane(windowId, key))
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
    remote?.clear()
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
  handle('hosts:snapshot', () => manager.snapshot())
}
