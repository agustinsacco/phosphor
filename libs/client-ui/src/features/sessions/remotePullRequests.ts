import { useEffect } from 'react'
import { prKey } from '@shared/github-pr-refs'
import { parseRemotePrKey, remotePrKey } from '@shared/host-protocol-github'
import type { HostLaneView } from '@shared/ipc'
import type { GhPrRef } from '@shared/models'
import { retainPrRoutes } from '@/stores/prRoutes'
import { useRepoPrRefresh } from './repoPrRefresh'
import { machineCaps } from '@/stores/machineCaps'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { pullRequestFor, usePullRequestsStore } from '@/stores/pullRequests'

// Cache ownership is the Host snapshot, not a sidebar/home component's lifetime.
useRemoteLanesStore.subscribe((state, previous) => {
  if (state.hosts === previous.hosts) return
  for (const key of Object.keys(usePullRequestsStore.getState().byRepo)) {
    const scope = parseRemotePrKey(key)
    if (scope && !state.hosts[scope.hostId]?.repositories.some((r) => r.id === scope.repositoryId))
      usePullRequestsStore.getState().remove(key)
  }
})

/** Repository-scoped batches: never per-lane subprocesses or caller filesystem paths. */
export function useRemotePullRequests(
  hostId: string,
  repositoryId: string,
  expanded: boolean,
): void {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const key = remotePrKey(hostId, repositoryId)
  const ready = machineCaps(host).can('workspaces.read')
  useRepoPrRefresh(ready && expanded ? [key] : [], host?.lanes)
}
export function useRemotePr(hostId: string | undefined, lane: HostLaneView) {
  const key = hostId ? remotePrKey(hostId, lane.repositoryId) : undefined
  const pr = usePullRequestsStore((s) => pullRequestFor(s, key, lane.branch))
  return pr
}

/**
 * Read `refs` by number through `hostId` while mounted; undefined reads nothing
 * through a Host. Call it before `usePrStatusRefresh`: effects run in order, so
 * the first read already goes to the Host.
 */
export function useHostPrRoutes(hostId: string | undefined, refs: readonly GhPrRef[]): void {
  const key = JSON.stringify(
    [...new Map(refs.map((ref) => [prKey(ref), ref])).values()].sort((a, b) =>
      prKey(a).localeCompare(prKey(b)),
    ),
  )
  useEffect(
    () => (hostId ? retainPrRoutes(hostId, JSON.parse(key) as GhPrRef[]) : undefined),
    [hostId, key],
  )
}
