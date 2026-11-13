import { prKey } from '@shared/github-pr-refs'
import { prStatusMachine } from '@shared/host-protocol-pr-status'
import type { GhPrKey, GhPrRef } from '@shared/models'

/**
 * Which machine reads a PR by number. A Host lane in view registers its PRs
 * here, so `gh:prSummaries` and `gh:prDetail` for them go through that Host's
 * gh; a PR no Host lane registered reads on This Mac. Status and detail stay
 * keyed by PR: the same PR read here or through a Host is the same PR.
 */
const routes = new Map<GhPrKey, Map<string, number>>()

/** Register `refs` as read through `hostId` until the returned release runs. */
export function retainPrRoutes(hostId: string, refs: readonly GhPrRef[]): () => void {
  const keys = [...new Set(refs.map(prKey))]
  for (const key of keys) {
    const hosts = routes.get(key) ?? new Map<string, number>()
    hosts.set(hostId, (hosts.get(hostId) ?? 0) + 1)
    routes.set(key, hosts)
  }
  return () => {
    for (const key of keys) {
      const hosts = routes.get(key)
      const count = hosts?.get(hostId) ?? 0
      if (count > 1) hosts!.set(hostId, count - 1)
      else hosts?.delete(hostId)
      if (hosts && !hosts.size) routes.delete(key)
    }
  }
}

/** The `machine` argument for a PR's reads: a registered Host, else undefined (This Mac). */
export function prRouteOf(key: GhPrKey): string | undefined {
  const hostId = routes.get(key)?.keys().next().value
  return hostId === undefined ? undefined : prStatusMachine(hostId)
}
