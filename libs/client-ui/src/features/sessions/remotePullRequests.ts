import { parseRemotePrKey, remotePrKey } from '@shared/host-protocol-github'
import type { HostLaneView } from '@shared/ipc'
import { useRepoPrRefresh } from './repoPrRefresh'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { pullRequestFor, repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'

// Cache ownership is the Host snapshot, not a sidebar/home component's lifetime.
useRemoteLanesStore.subscribe((state, previous) => {
  if (state.hosts === previous.hosts) return
  for (const key of Object.keys(usePullRequestsStore.getState().byRepo)) {
    const scope = parseRemotePrKey(key)
    if (scope && !state.hosts[scope.hostId]?.repositories.some((r) => r.id === scope.repositoryId))
      usePullRequestsStore.getState().remove(key)
  }
})

/** Repository-wide reads: never one gh subprocess per lane or a local filesystem path. */
export function useRemotePullRequests(
  hostId: string,
  repositoryId: string,
  expanded: boolean,
): void {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const key = remotePrKey(hostId, repositoryId)
  const ready = host?.state === 'ready' && host.capabilities.includes('workspaces.read')
  useRepoPrRefresh(ready && expanded ? [key] : [], host?.lanes)
}
export function useRemotePr(hostId: string | undefined, lane: HostLaneView) {
  const key = hostId ? remotePrKey(hostId, lane.repositoryId) : undefined
  const pr = usePullRequestsStore((s) => pullRequestFor(s, key, lane.branch))
  const complete = usePullRequestsStore((s) => repoPullRequests(s, key).complete)
  return { pr, confirmedNoPr: complete && !!lane.worktree && !!lane.branch && !pr }
}
