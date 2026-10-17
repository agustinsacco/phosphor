import { app } from 'electron'
import {
  accountAccessToken,
  accountControlGeneration,
  accountSnapshot,
  onAccountChange,
} from '../account'
import { supabaseTarget } from '../account/config'
import { broadcast } from '../broadcast'
import { createMachinesLive } from '../control/live'
import { createRealtime, liveTimers } from '../control/realtime'
import { controlUrl, createControlClient } from '../control/client'
import { handle } from './handle'
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

export function registerControlHandlers(): void {
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
  handle('control:machines', () => client.machines())
  handle('control:lookupEnrollment', (_event, code) => client.lookupEnrollment(code))
  handle('control:approveEnrollment', (_event, code, label) =>
    client.approveEnrollment(code, label),
  )
  handle('control:renameMachine', (_event, id, label) => client.renameMachine(id, label))
  handle('control:removeMachine', (_event, id) => client.removeMachine(id))
}
