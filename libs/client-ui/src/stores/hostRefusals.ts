import { HOST_TOO_OLD } from '@shared/host-protocol-repositories'
import type { HostConnectionView } from '@shared/ipc'
import type { HostCapability } from '@shared/remote-host'

export const REMOTE_NOT_READY = 'Machine not connected. Wait for reconnection.'

/** Capabilities control grants every client; configuration is a separate opt-in. */
type GrantedCapability = Exclude<HostCapability, 'machine.configure'>

/** What each capability lets this device use, in the words a refusal names it. */
const FEATURE_NAMES: Record<GrantedCapability, string> = {
  'sessions.read': 'lanes',
  'sessions.control': 'lane control',
  'workspaces.read': 'files',
  'workspaces.write': 'file editing',
  'artifacts.read': 'artifacts',
  'skills.read': 'skills',
  terminal: 'terminals',
  routines: 'routines',
}

/** A Host refused an operation it predates; `subject` ends in its verb ("Pins need"). */
export function needsNewerHost(subject: string): string {
  return `${subject} a newer Host. ${HOST_TOO_OLD}`
}

/** A ready Host that does not grant this device `capability`, in the words both shells show. */
export function featureNotOffered(capability: GrantedCapability): string {
  return `This Host does not offer ${FEATURE_NAMES[capability]} to this device.`
}

/**
 * Why this device cannot use a Host feature now, or undefined when it can; Desktop and the
 * browser show the same words. Control grants all of these, so a missing one is a feature
 * this Host does not offer.
 */
export function hostFeatureRefusal(
  host: Pick<HostConnectionView, 'state' | 'capabilities'> | undefined,
  capability: GrantedCapability,
): string | undefined {
  if (host?.state !== 'ready') return REMOTE_NOT_READY
  if (host.capabilities.includes(capability)) return undefined
  return featureNotOffered(capability)
}
