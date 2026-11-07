import { useEffect, useMemo } from 'react'
import { remotePrKey } from '@shared/host-protocol-github'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { machineCaps } from '@/stores/machineCaps'
import { useSessionHostLane } from '@/stores/remoteLanes'
import { repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'
import { useRepoPrRefresh } from './repoPrRefresh'
// Also installs Host-owned cache eviction, independent of sidebar visibility.
import './remotePullRequests'

/** Resolve from this lane, never from a global workspace or machine filter. */
export function useLanePullRequest(sessionId: string) {
  const entry = useSessionsStore((s) => s.live[sessionId])
  const git = useSessionsStore((s) => s.gitByCwd[entry?.workspacePath ?? ''])
  const streaming = useChatStore((s) => s.sessions[sessionId]?.isStreaming ?? false)
  const hostLane = useSessionHostLane(sessionId)
  const remote = hostLane !== null
  const host = hostLane?.host
  const lane = hostLane?.lane
  const repository = host?.repositories.find((item) => item.id === lane?.repositoryId)
  const ready = remote
    ? machineCaps(host).can('workspaces.read') && !!repository
    : !!entry && git?.isRepo === true
  const repoPath = remote
    ? repository
      ? remotePrKey(hostLane.hostId, repository.id)
      : undefined
    : git?.isRepo
      ? (git.mainRepoPath ?? entry?.workspacePath)
      : undefined
  const branch = remote ? lane?.branch : git?.branch
  const slice = usePullRequestsStore((s) => repoPullRequests(s, repoPath))
  const revision = useMemo(
    () => ({ sessionId, streaming, lanes: host?.lanes }),
    [sessionId, streaming, host?.lanes],
  )
  useRepoPrRefresh(ready && repoPath ? [repoPath] : [], revision)
  useLaneGitInfo(remote ? undefined : entry?.workspacePath, streaming)
  const pr = branch ? slice.byBranch[branch] : undefined
  return { repoPath, ready, slice, pr, branch: branch ?? undefined }
}

function useLaneGitInfo(cwd: string | undefined, streaming: boolean): void {
  useEffect(() => {
    if (!cwd) return
    const refresh = (): void => {
      if (!document.hidden) void useSessionsStore.getState().refreshGitInfo([cwd])
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [cwd, streaming])
}
