import type { HostsSnapshot } from '@phosphor/shared/ipc'

/** The directory need not know this machine. Only the trusted local slot marks its projection. */
export function localServiceId(hosts: HostsSnapshot): string | undefined {
  return Object.keys(hosts).find((id) => hosts[id]?.local)
}

/** Resolve the legacy selection without changing any persisted keys. */
export function serviceScope(scope: string, hosts: HostsSnapshot): string {
  return scope === 'local' ? (localServiceId(hosts) ?? scope) : scope
}

export function orderedHostIds(ids: readonly string[], hosts: HostsSnapshot): string[] {
  const local = localServiceId(hosts)
  return [...new Set([...(local ? [local] : []), ...ids, ...Object.keys(hosts)])]
}
