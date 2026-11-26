import type { HostConnectionView } from '@shared/ipc'

type ReadinessSource = Pick<HostConnectionView, 'state' | 'capabilities'> | undefined

/**
 * Connected and granting something: the Host can act now. A local service accepts its
 * socket before its lanes start and grants nothing until it reconnects with them, so a
 * `ready` connection without capabilities is still starting. Decided by data, the same
 * on every surface.
 */
export function hostReady(host: ReadinessSource): boolean {
  return host?.state === 'ready' && host.capabilities.length > 0
}

/** Connected, but its lanes have not started: nothing can be sent yet. */
export function hostStarting(host: ReadinessSource): boolean {
  return host?.state === 'ready' && host.capabilities.length === 0
}

/** What a lane says while its machine starts. */
export function startingMachine(label: string): string {
  return `Starting ${label}…`
}
