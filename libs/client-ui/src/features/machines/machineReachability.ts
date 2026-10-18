import { machineStatus, CONTROL_LIMITS, type MachineView } from '@shared/control-api'
import type { HostConnectionView } from '@shared/ipc'
import { relativeTime } from './machinePresentation'

export interface Reachability {
  ok: boolean
  /** A few words for rows, chips and the sidebar. */
  short: string
  detail: string
  /** One command to run on the Host, when one would fix it. */
  command?: string
}

const REFUSED = new Set(['forbidden', 'grant-refused', 'account-disabled'])

/**
 * Enrollment and Tailscale readiness do not prove a usable Host address.
 * `now` must already include the control plane's clock correction.
 */
export function machineReachability(
  machine: MachineView,
  connection: HostConnectionView['state'] | undefined,
  now: number,
  lastError?: string,
): Reachability {
  const label = machine.label
  if (connection === 'ready')
    return { ok: true, short: 'Reachable', detail: `${label} is reachable.` }
  if (!machine.lastSeenAt)
    return {
      ok: false,
      short: 'Never connected',
      detail: `${label} has never connected.`,
      command: 'phosphor setup',
    }
  // Offline first: an address that was never published is not the problem when nothing checks in.
  if (machineStatus(machine, now) === 'down')
    return {
      ok: false,
      short: 'Host offline',
      detail: `${label} has not checked in since ${relativeTime(machine.lastSeenAt, now)}. If it is awake, restart its Host service there:`,
      command: 'phosphor service restart',
    }
  if (!machine.endpoint) {
    const tailscale = machine.readiness?.tailscale
    if (tailscale === 'stopped' || tailscale === 'missing')
      return {
        ok: false,
        short: tailscale === 'missing' ? 'Tailscale missing' : 'Tailscale stopped',
        detail: `${label} cannot publish its address until Tailscale runs there. On ${label}, start Tailscale and sign in, then run:`,
        command: 'phosphor setup',
      }
    return {
      ok: false,
      short: 'Not reachable yet',
      detail: `${label} is enrolled but not reachable. On ${label} run:`,
      // Only Linux needs the operator setting; setup asks for it anywhere it is missing.
      command:
        machine.platform === 'linux'
          ? 'sudo tailscale set --operator=$USER && phosphor setup'
          : 'phosphor setup',
    }
  }
  if (connection === 'unsupported')
    return {
      ok: false,
      short: 'Update needed',
      detail: `${label} runs a Host this version of Phosphor cannot talk to. Update both, then reconnect. On ${label} run:`,
      command: 'phosphor update',
    }
  if (connection === 'wrong-machine')
    return {
      ok: false,
      short: 'Identity mismatch',
      detail: `The machine at ${label}'s address could not prove it is ${label}. Remove ${label} and add it again.`,
    }
  if (
    (connection === 'connecting' || connection === 'reconnecting') &&
    lastError &&
    REFUSED.has(lastError)
  )
    return {
      ok: false,
      short: 'Access refused',
      detail: `${label} refused this computer's access. Reconnect to try again.`,
    }
  if (connection === 'connecting' || connection === 'reconnecting')
    return { ok: false, short: 'Connecting…', detail: `Connecting to ${label}.` }
  // The Host is checking in, so restarting it is not the fix: the path between the two is.
  return {
    ok: false,
    short: 'Not reachable',
    detail: `${label} is online, but this computer cannot reach it. Check that Tailscale is on here and that both computers are on the same tailnet.`,
  }
}

export type Tone = 'ok' | 'warn' | 'error' | 'off' | 'pending'
export interface Headline extends Reachability {
  tone: Tone
  /** The one status a row, header or badge shows for this machine. */
  label: string
}

/** One status per machine, so no surface says "Online · Not reachable yet". */
export function machineHeadline(
  machine: MachineView,
  connection: Pick<HostConnectionView, 'state' | 'lastError'> | undefined,
  now: number,
): Headline {
  const reach = machineReachability(machine, connection?.state, now, connection?.lastError)
  if (reach.ok) return { ...reach, tone: 'ok', label: 'Connected' }
  if (!machine.lastSeenAt) return { ...reach, tone: 'pending', label: 'Waiting for setup' }
  if (machineStatus(machine, now) === 'down') {
    const stopping =
      machine.state === 'stopping' &&
      now - Date.parse(machine.lastSeenAt) <= CONTROL_LIMITS.downAfterSec * 1000
    return { ...reach, tone: 'off', label: stopping ? 'Stopping' : 'Offline' }
  }
  if (reach.short === 'Connecting…') return { ...reach, tone: 'pending', label: 'Connecting…' }
  if (reach.short === 'Identity mismatch') return { ...reach, tone: 'error', label: reach.short }
  return {
    ...reach,
    tone: 'warn',
    label: reach.short === 'Not reachable yet' ? 'Not reachable' : reach.short,
  }
}
