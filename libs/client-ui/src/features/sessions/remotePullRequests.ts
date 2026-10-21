import { useEffect } from 'react'
import { parseRemotePrKey, remotePrKey } from '@shared/host-protocol-github'
import type { HostLaneView } from '@shared/ipc'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import {
  PR_STALE_MS,
  pullRequestFor,
  repoPullRequests,
  usePullRequestsStore,
} from '@/stores/pullRequests'

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
  useEffect(() => {
    if (!ready || !expanded) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      clearTimeout(timer)
      const store = usePullRequestsStore.getState()
      const slice = repoPullRequests(store, key)
      const delay = Math.max(0, (slice.fetchedAt || slice.attemptedAt) + PR_STALE_MS - Date.now())
      if (delay > 0)
        timer = setTimeout(() => {
          void store.refresh(key)
        }, delay)
      else void store.refresh(key)
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [key, ready, expanded, host?.connectionToken, host?.lanes])
}
export function useRemotePr(hostId: string | undefined, lane: HostLaneView) {
  const key = hostId ? remotePrKey(hostId, lane.repositoryId) : undefined
  const pr = usePullRequestsStore((s) => pullRequestFor(s, key, lane.branch))
  const complete = usePullRequestsStore((s) => repoPullRequests(s, key).complete)
  return { pr, confirmedNoPr: complete && !!lane.worktree && !!lane.branch && !pr }
}
