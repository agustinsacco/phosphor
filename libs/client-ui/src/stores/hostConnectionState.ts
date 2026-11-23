import type { HostConnectionView, HostsSnapshot } from '@shared/ipc'

/** These retry on their own; every other state that is not ready needs the user. */
export function hostReconnecting(state: HostConnectionView['state'] | undefined): boolean {
  return state === 'connecting' || state === 'reconnecting'
}

/** Still reaching this Host: retrying, or the first snapshot has not listed it yet. */
export function hostPending(s: { hosts: HostsSnapshot; snapshotStatus: string }, hostId: string) {
  const host = s.hosts[hostId]
  return host ? hostReconnecting(host.state) : s.snapshotStatus === 'loading'
}
