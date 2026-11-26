import { app } from 'electron'
import type { AccountView } from '@shared/account'
import {
  accountAccessToken,
  accountControlGeneration,
  accountSnapshot,
  accountUserId,
  onAccountChange,
} from '../account'
import { supabaseTarget } from '../account/config'
import { broadcast } from '../broadcast'
import { createMachinesLive } from './live'
import { createRealtime, liveTimers } from './realtime'
import { controlUrl, createControlClient } from './client'
import { tappedLog } from '../hosts/traffic-tap'

const client = createControlClient({
  baseUrl: () => controlUrl(app.isPackaged, process.env),
  accessToken: accountAccessToken,
  generation: accountControlGeneration,
  version: () => app.getVersion(),
  log: tappedLog,
})

export const controlClient = () => client
const machineListeners = new Set<() => void>()
export function onMachinesChanged(listener: () => void): () => void {
  machineListeners.add(listener)
  return () => {
    machineListeners.delete(listener)
  }
}
function machinesChanged() {
  broadcast('control:machinesChanged', undefined)
  for (const listener of machineListeners) listener()
}

let remoteActive = false
const remoteListeners = new Set<(view: AccountView) => void>()

export function onRemoteAccountChange(listener: (view: AccountView) => void): () => void {
  remoteListeners.add(listener)
  return () => {
    remoteListeners.delete(listener)
  }
}

export const remoteAccountUserId = () => (remoteActive ? accountUserId() : null)

function notifyRemote(view: AccountView) {
  for (const listener of remoteListeners) listener(view)
}

/** Called by Machines. A remembered profile alone is not a request to unlock the account. */
export function activateRemoteAccess(): void {
  if (remoteActive) return
  const view = accountSnapshot()
  if (view.account.status !== 'signed-in') return
  remoteActive = true
  notifyRemote(view)
}

export function initControlRuntime(): void {
  let signingIn = false
  const off = onAccountChange((view) => {
    const status = view.account.status
    if (status !== 'signed-in') client.clearObservations()
    const wasActive = remoteActive
    remoteActive = status === 'signed-in' && (remoteActive || signingIn)
    signingIn = status === 'signing-in'
    if (remoteActive || wasActive) notifyRemote(view)
  })
  app.once('will-quit', off)
  const stop = createMachinesLive({
    snapshot: () => (remoteActive ? accountSnapshot() : { account: { status: 'signed-out' } }),
    log: tappedLog,
    subscribe: onRemoteAccountChange,
    timers: liveTimers,
    broadcast: machinesChanged,
    realtime: (changed, joined) =>
      createRealtime({
        log: tappedLog,
        target: supabaseTarget(app.isPackaged, process.env),
        socket: (url) => new WebSocket(url),
        accessToken: accountAccessToken,
        generation: accountControlGeneration,
        timers: liveTimers,
        now: Date.now,
        random: Math.random,
        changed,
        joined,
      }),
  })
  app.once('will-quit', stop)
}
