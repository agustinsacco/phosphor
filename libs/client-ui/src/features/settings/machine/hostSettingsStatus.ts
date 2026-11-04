import type { MachineView } from '@shared/control-api'
import type { HostConnectionView } from '@shared/ipc'
import type { NoticeTone } from '@/components/form'
import { machineReachability, type Reachability } from '@/features/machines/machineReachability'

/** What the gate's one button does. */
export type HostGateAction = 'reconnect' | 'enable-access' | 'retry' | 'account'

export interface HostGateNotice {
  tone: NoticeTone
  title: string
  detail: string
  /** One command to run on the Host, when one would fix it. */
  command?: string
  /** The link's last error code, when the reachability text does not already explain it. */
  lastError?: string
  action?: HostGateAction
}

export type HostSettingsStatus =
  { kind: 'ready' } | { kind: 'loading' } | ({ kind: 'notice' } & HostGateNotice)

export interface HostSettingsStatusInput {
  label: string
  /** The control plane's record, when this client has one; reachability reads it. */
  machine: MachineView | undefined
  connection: Pick<HostConnectionView, 'state' | 'lastError' | 'configurationSupported'> | undefined
  /** This client holds the configuration grant (`machine.configure`). */
  allowed: boolean
  /** What the section reads: its settings, or nothing but the link (`connection`). */
  reads: 'settings' | 'connection'
  read: { loading: boolean; error: string | null; loaded: boolean }
  /** Already corrected by the control plane's clock offset. */
  now: number
}

/** States that no Reconnect from here can fix. */
const NO_RECONNECT = new Set(['Identity mismatch', 'Update needed', 'Connecting…'])

/**
 * The one state a Host section shows before its settings: each connection
 * state in the Machines page's words, then the Host's version, the
 * configuration grant, and the settings read itself. A section that reads
 * nothing but the link is ready once the link is.
 */
export function hostSettingsStatus(input: HostSettingsStatusInput): HostSettingsStatus {
  const { label, connection, allowed, read } = input
  if (connection?.state !== 'ready') return { kind: 'notice', ...connectionNotice(input) }
  if (input.reads === 'connection') return { kind: 'ready' }
  if (!connection.configurationSupported)
    return {
      kind: 'notice',
      tone: 'warning',
      title: 'Update this Host to use machine settings',
      detail: `This version of ${label} does not offer the machine settings API. Run this on ${label}, then reconnect:`,
      command: 'phosphor update',
    }
  if (!allowed)
    return {
      kind: 'notice',
      tone: 'info',
      title: 'Configuration access is not enabled',
      detail:
        'Viewing lanes and controlling a session do not automatically permit machine-wide configuration. Explicitly enable settings access for this client.',
      action: 'enable-access',
    }
  if (read.loaded) return { kind: 'ready' }
  if (read.error)
    return {
      kind: 'notice',
      tone: 'danger',
      title: `Could not read ${label}’s settings`,
      detail: read.error,
      action: 'retry',
    }
  return { kind: 'loading' }
}

function connectionNotice({
  label,
  machine,
  connection,
  now,
}: HostSettingsStatusInput): HostGateNotice {
  if (connection?.state === 'signed-out')
    return {
      tone: 'warning',
      title: 'Signed out',
      detail: `Sign in to your Phosphor account to reach ${label}. Nothing is queued for later, and this computer’s settings are never substituted.`,
      action: 'account',
    }
  const reach = machine
    ? machineReachability(machine, connection?.state, now, connection?.lastError)
    : unlistedReachability(label, connection)
  const pending = reach.short === 'Connecting…'
  return {
    tone: pending ? 'info' : reach.short === 'Identity mismatch' ? 'danger' : 'warning',
    title: reach.short,
    detail: pending
      ? reach.detail
      : `${reach.detail} Nothing is queued for later, and this computer’s settings are never substituted.`,
    command: reach.command,
    lastError:
      connection?.lastError && reach.short !== 'Access refused' ? connection.lastError : undefined,
    action: NO_RECONNECT.has(reach.short) ? undefined : 'reconnect',
  }
}

/** A Host the control plane has not listed (yet): only the link's own state is known. */
function unlistedReachability(
  label: string,
  connection: HostSettingsStatusInput['connection'],
): Reachability {
  switch (connection?.state) {
    case 'connecting':
    case 'reconnecting':
      return { ok: false, short: 'Connecting…', detail: `Connecting to ${label}.` }
    case 'wrong-machine':
      return {
        ok: false,
        short: 'Identity mismatch',
        detail: `The machine at ${label}'s address could not prove it is ${label}. Remove ${label} and add it again.`,
      }
    case 'unsupported':
      return {
        ok: false,
        short: 'Update needed',
        detail: `${label} runs a Host this version of Phosphor cannot talk to. Update both, then reconnect. On ${label} run:`,
        command: 'phosphor update',
      }
    default:
      return { ok: false, short: 'Not connected', detail: `${label} is not connected.` }
  }
}
