import type { HostConnectionView } from '@shared/ipc'

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
