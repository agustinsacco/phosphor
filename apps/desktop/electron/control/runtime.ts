import { app } from 'electron'
import {
  accountAccessToken,
  accountControlGeneration,
  accountSnapshot,
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

export function initControlRuntime(): void {
  const off = onAccountChange((view) => {
    if (view.account.status !== 'signed-in') client.clearObservations()
  })
  app.once('will-quit', off)
  const stop = createMachinesLive({
    snapshot: accountSnapshot,
    log: tappedLog,
    subscribe: onAccountChange,
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
