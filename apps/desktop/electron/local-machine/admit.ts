import { notifyLocalMachineChanged } from '../ipc/local-machine-handlers'
import { app } from 'electron'
import { desktopBrainApp } from '../brain/app-service'
import { broadcast } from '../broadcast'
import { bindLocalEnrollment } from '../control/local-enroll-binding'
import type { createHostAttention } from '../hosts/attention'
import type { createHostManager } from '../hosts/manager'
import { trafficLog } from '../hosts/traffic-log'
import { tappedLog } from '../hosts/traffic-tap'
import { startLocalMachine } from './connection'
import { onDaemonMode } from './mode'
import { bindSameMachine, sameMachine } from './same-machine'

type ControlClient = Parameters<typeof bindLocalEnrollment>[1]

/** Inert until the launch gate decides daemon mode (M3): then This Mac's service joins the manager. */
export function admitLocalMachine(
  manager: ReturnType<typeof createHostManager>,
  attention: ReturnType<typeof createHostAttention>,
  control: () => ControlClient,
): void {
  onDaemonMode((access) => {
    let id: string | undefined
    const enroll = bindLocalEnrollment(manager, control(), () => id)
    const local = startLocalMachine({
      ...access,
      uid: process.getuid?.(),
      attach: (slot) => {
        manager.setLocal(slot)
        const hostId = slot?.hostId
        id = hostId
        enroll.changed()
        bindSameMachine(hostId ? { hostId, connection: () => manager.connection(hostId) } : null)
        desktopBrainApp.ownerChanged(sameMachine()?.connection)
        notifyLocalMachineChanged()
      },
      changed: () => {
        desktopBrainApp.ownerChanged(sameMachine()?.connection)
        notifyLocalMachineChanged()
        manager.changed()
        enroll.changed()
      },
      log: tappedLog,
      traffic: (hostId, direction, frame, bytes) => {
        if (direction === 'in' && frame.type === 'lanes' && frame.id === 'lanes')
          desktopBrainApp.lanesSnapshot()
        trafficLog.frame(hostId, direction, frame, bytes)
      },
      onAttention: (hostId, event) => attention.receive(hostId, event),
      onRoutinesChanged: (hostId) => broadcast('routines:changed', { machine: `host:${hostId}` }),
    })
    app.once('will-quit', () => {
      enroll.stop()
      local.stop()
    })
  })
}
