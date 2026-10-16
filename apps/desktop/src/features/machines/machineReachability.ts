import { machineStatus, type MachineView } from '@shared/control-api'
import type { HostConnectionView } from '@shared/ipc'
import { relativeTime } from './machinePresentation'

/** Enrollment and Tailscale readiness do not prove a usable Host address. */
export function machineReachability(
  machine: MachineView,
  connection: HostConnectionView['state'] | undefined,
  now: number,
) {
  if (connection === 'ready')
    return { ok: true, short: 'Reachable', detail: `${machine.label} is reachable.` }
  if (!machine.lastSeenAt)
    return {
      ok: false,
      short: 'Never connected',
      detail: `${machine.label} has never connected.`,
      command: 'phosphor setup',
    }
  if (!machine.endpoint)
    return {
      ok: false,
      short: 'Not reachable yet',
      detail: `${machine.label} is enrolled but not reachable. On ${machine.label} run:`,
      command: 'sudo tailscale set --operator=$USER && phosphor setup',
    }
  if (machineStatus(machine, now) === 'down')
    return {
      ok: false,
      short: 'Host offline',
      detail: `${machine.label} is stopped or offline. Last seen ${relativeTime(machine.lastSeenAt, now)}.`,
      command: 'phosphor service restart',
    }
  if (connection === 'connecting' || connection === 'reconnecting')
    return { ok: false, short: 'Connecting…', detail: `Connecting to ${machine.label}.` }
  return {
    ok: false,
    short: 'Host offline',
    detail: `${machine.label} is not reachable. Last seen ${relativeTime(machine.lastSeenAt, now)}.`,
    command: 'phosphor service restart',
  }
}
