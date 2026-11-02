import { laneMarks } from '@phosphor/host-client/lane-marks'
import { repositoryManagement } from '@phosphor/host-client/repository-management'
import { repositoryReads } from '../hosts/repository-reads'
import { machineReads } from '../hosts/machine-reads'
import { registerHostSettingsHandlers } from './host-settings-handlers'
import { uploadAttachments } from '../hosts/attachments'
import { routeRemoteWrite } from '../hosts/write-features'
import type { SessionPush } from '@shared/models'
import { app, BrowserWindow, Notification } from 'electron'
import { hostname } from 'node:os'
import { accountUserId, onAccountChange } from '../account'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { getConfigureHosts, getRemoteClients, setConfigureHosts, setRemoteClients } from '../store'
import { createClientIds } from '../hosts/client-id'
import { createConfigureHosts } from '../hosts/configure-hosts'
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
import { createRemoteTerminals } from '@phosphor/host-client/terminals/terminals'
import { createRemoteRoutines } from '../hosts/routines'
import { createHostAttention, readHostReceipt } from '../hosts/attention'
import { trafficLog } from '../hosts/traffic-log'
import { tappedLog } from '../hosts/traffic-tap'

let routines: ReturnType<typeof createRemoteRoutines> | undefined
export const remoteRoutineMachines = () => routines?.machines() ?? []
let remote: RemoteLanes | undefined
export function remoteLanes(): RemoteLanes {
  if (!remote) throw new Error('Remote lanes are not ready.')
  return remote
}

function registerCatalogueHandlers(catalogues: ReturnType<typeof machineReads>): void {
  handle('hosts:models', (_event, hostId) => catalogues.models(hostId))
  handle('hosts:claude', (_event, hostId) => catalogues.claude(hostId))
  handle('hosts:claudeUsage', (_event, ...args) => catalogues.claudeUsage(...args))
  handle('hosts:providers', (_event, hostId) => catalogues.providers(hostId))
  handle('hosts:skills', (_event, hostId) => catalogues.skills(hostId))
}

/** Folders, lane deletion and lane pins and markers: changes a Host keeps for every client. */
function registerManagementHandlers(
  connection: Parameters<typeof repositoryManagement>[0] & Parameters<typeof laneMarks>[0],
): void {
  const management = repositoryManagement(connection)
  const marks = laneMarks(connection)
  handle('hosts:listFolders', (_event, hostId, path, hidden) =>
    management.folders(hostId, path, hidden),
  )
  handle('hosts:createFolder', (_event, hostId, path) => management.createFolder(hostId, path))
  handle('hosts:addRepository', (_event, hostId, path) => management.add(hostId, path))
  handle('hosts:removeRepository', (_event, hostId, repositoryId) =>
    management.remove(hostId, repositoryId),
  )
  handle('hosts:orderRepositories', (_event, hostId, repositoryIds) =>
    management.order(hostId, repositoryIds),
  )
  handle('hosts:deleteLane', (_event, hostId, laneId, options) =>
    management.deleteLane(hostId, laneId, options),
  )
  handle('hosts:setLaneMarks', (_event, hostId, laneId, change) =>
    marks.set(hostId, laneId, change),
  )
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
  const configured = createConfigureHosts({
    user: accountUserId,
    read: getConfigureHosts,
    write: setConfigureHosts,
  })
  const grants = createGrants({
    control,
    clients,
    configured,
    present: (id) => manager.present(id),
  })
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
        socket: (url) => openHostSocket(url, tappedLog, testEndpoint),
        grant: () => grants.grantFor(hostId),
        clearGrant: () => grants.clear(hostId),
        changed: () => manager.changed(),
        disabled: () => manager.disabled(),
        onRoutinesChanged: () => broadcast('routines:changed', { machine: `host:${hostId}` }),
        onAttention: (event) => attention.receive(hostId, event),
        log: tappedLog,
        traffic: (direction, frame, bytes) => trafficLog.frame(hostId, direction, frame, bytes),
      }),
  })
  registerManagementHandlers(manager.connection)
  const repositories = repositoryReads(manager.connection)
  handle('hosts:repositoryFiles', (_event, hostId, repositoryId) =>
    repositories.list(hostId, repositoryId),
  )
  handle('hosts:repositoryFile', (_event, hostId, repositoryId, path) =>
    repositories.read(hostId, repositoryId, path),
  )
  const catalogues = machineReads(manager.connection)
  registerCatalogueHandlers(catalogues)
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
    unrefTimer: (timer) => timer.unref(),
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
    if (channel === 'gh:prsForRepo' && typeof key === 'string' && key.startsWith('host:'))
      return { result: repositories.pullRequests(key) }
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
    receipt: (hostId, laneId) => readHostReceipt(manager.connection, hostId, laneId),
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
  handle('hosts:releaseControl', (_event, hostId, laneId) =>
    remoteLanes().action(hostId, laneId, 'control.release'),
  )
  handle('hosts:markRead', (_event, hostId, laneId) =>
    remoteLanes().action(hostId, laneId, 'lane.markRead'),
  )
  handle('hosts:exportLaneHtml', (event, sessionId) =>
    remoteLanes().exportHtml(event.sender.id, sessionId),
  )
  handle('hosts:setFocusedLane', (event, target) => {
    window(event)
    remoteLanes().setFocused(event.sender.id, target)
  })
  registerHostSettingsHandlers(manager, grants, terminals)
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
