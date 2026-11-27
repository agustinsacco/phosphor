import type { HostConnectionView } from '@shared/ipc'
import { connectionLabel } from './hostRefusals'

type ReadinessSource = Pick<HostConnectionView, 'state' | 'capabilities'> | undefined
type StartingSource = (ReadinessSource & Pick<HostConnectionView, 'local'>) | undefined

/**
 * Connected and granting something: the Host can act now. A `ready` connection without
 * capabilities is never usable. Decided by data, the same on every surface.
 */
export function hostReady(host: ReadinessSource): boolean {
  return host?.state === 'ready' && host.capabilities.length > 0
}

/**
 * This Mac's service, connected before its lanes start: it accepts the owner socket,
 * grants nothing, then reconnects with its capabilities. Only the local socket has that
 * boot window. An enrolled Host serves its TCP API after its lanes start, so one that
 * grants nothing is unavailable, not starting, and must not spin forever.
 */
export function hostStarting(host: StartingSource): boolean {
  return host?.local === true && host.state === 'ready' && host.capabilities.length === 0
}

/** What a lane says while its machine starts. */
export function startingMachine(label: string): string {
  return `Starting ${label}…`
}

/**
 * How long This Mac's service may grant nothing before it reads as not connected: the
 * client's lane.resume window (host-client `PI_START_WAIT_MS`). Past it, nothing the
 * service was starting can still land, so "Starting" would only spin.
 */
export const MACHINE_START_LIMIT_MS = 180_000

/** What every surface says about a Host: the lane header, its chip and the composer's note. */
export type HostPhase = 'ready' | 'starting' | 'connecting' | 'not-connected'

/** `startExpired`: This Mac's boot window outlasted `MACHINE_START_LIMIT_MS`. */
export function hostPhase(host: StartingSource, startExpired = false): HostPhase {
  if (hostReady(host)) return 'ready'
  if (hostStarting(host) && !startExpired) return 'starting'
  if (host?.state === 'connecting' || host?.state === 'reconnecting') return 'connecting'
  return 'not-connected'
}

/** A header's word for a phase: Connected, Starting, Connecting, Reconnecting or Down. */
export function hostPhaseLabel(
  phase: HostPhase,
  state: HostConnectionView['state'] | undefined,
): string {
  if (phase === 'ready') return 'Connected'
  if (phase === 'starting') return 'Starting'
  return connectionLabel(phase === 'connecting' ? state : undefined)
}
