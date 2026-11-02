import { useEffect, useMemo } from 'react'
import { remotePrKey } from '@shared/host-protocol-github'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'
import { useRepoPrRefresh } from './repoPrRefresh'
// Also installs Host-owned cache eviction, independent of sidebar visibility.
import './remotePullRequests'

/** Resolve from this lane, never from a global workspace or machine filter. */
export function useLanePullRequest(sessionId: string) {
  const entry = useSessionsStore((s) => s.live[sessionId])
  const git = useSessionsStore((s) => s.gitByCwd[entry?.workspacePath ?? ''])
  const streaming = useChatStore((s) => s.sessions[sessionId]?.isStreaming ?? false)
  const host = useRemoteLanesStore((s) =>
    entry?.target?.kind === 'remote' ? s.hosts[entry.target.hostId] : undefined,
  )
  const remote = entry?.target?.kind === 'remote'
  const lane = host?.lanes.find((item) => item.laneId === entry?.laneId)
  const repository = host?.repositories.find((item) => item.id === lane?.repositoryId)
  const ready = remote
    ? host?.state === 'ready' && host.capabilities.includes('workspaces.read') && !!repository
    : !!entry && git?.isRepo === true
  const repoPath = remote
    ? entry.target?.kind === 'remote' && repository
      ? remotePrKey(entry.target.hostId, repository.id)
      : undefined
    : git?.isRepo
      ? (git.mainRepoPath ?? entry?.workspacePath)
      : undefined
  const branch = remote ? lane?.branch : git?.branch
  const worktree = remote ? lane?.worktree : git?.isWorktree
  const slice = usePullRequestsStore((s) => repoPullRequests(s, repoPath))
  const revision = useMemo(
    () => ({ sessionId, streaming, lanes: host?.lanes }),
    [sessionId, streaming, host?.lanes],
  )
  useRepoPrRefresh(ready && repoPath ? [repoPath] : [], revision)
  useLaneGitInfo(remote ? undefined : entry?.workspacePath, streaming)
  const pr = branch ? slice.byBranch[branch] : undefined
  return {
    repoPath,
    ready,
    slice,
    pr,
    confirmedNoPr: !!worktree && !!branch && !pr && slice.complete,
  }
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
