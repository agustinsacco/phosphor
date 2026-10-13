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

const client = createControlClient({
  baseUrl: () => controlUrl(app.isPackaged, process.env),
  accessToken: accountAccessToken,
  generation: accountControlGeneration,
})

export function registerControlHandlers(): void {
  const stop = createMachinesLive({
    snapshot: accountSnapshot,
    subscribe: onAccountChange,
    timers: liveTimers,
    broadcast: () => broadcast('control:machinesChanged', undefined),
    realtime: (changed, joined) =>
      createRealtime({
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
