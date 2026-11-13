import { useEffect, useMemo } from 'react'
import { remotePrKey } from '@shared/host-protocol-github'
import type { GitInfo, SessionMeta } from '@shared/models'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { machineCaps } from '@/stores/machineCaps'
import { useSessionHostLane } from '@/stores/remoteLanes'
import { repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'
import { usePrStatusStore } from '@/stores/prStatus'
import { laneStatusRefs, resolveLanePrs, type LanePrs } from './lanePrs'
import { usePrStatusRefresh, useRepoPrRefresh } from './repoPrRefresh'
// Also installs Host-owned cache eviction, independent of sidebar visibility.
import { useHostPrRoutes } from './remotePullRequests'

type LaneMeta = Pick<SessionMeta, 'cwd' | 'pullRequests'>
type LaneGit = Pick<GitInfo, 'mainRepoPath' | 'branch'> | undefined

/** A worktree's PRs are discovered under its main repository. */
const repoOf = (meta: LaneMeta, git: LaneGit) => git?.mainRepoPath ?? meta.cwd

/** A This Mac lane's pull requests, read from the stores now: for one-off decisions. */
export function localLanePrs(meta: LaneMeta, git: LaneGit): LanePrs {
  return resolveLanePrs({
    signals: meta.pullRequests,
    branch: git?.branch,
    slice: repoPullRequests(usePullRequestsStore.getState(), repoOf(meta, git)),
    status: usePrStatusStore.getState().byKey,
  })
}

/** True when the lane has PRs and every one of them merged: "Select merged lanes". */
export function lanePrsAllMerged(prs: LanePrs): boolean {
  return prs.owned.length > 0 && prs.owned.every((lane) => lane.pr?.state === 'MERGED')
}

/** A sidebar row's PRs. The row registers its own PRs for reading by number. */
export function useLocalLanePrs(meta: LaneMeta, git: LaneGit): LanePrs {
  const slice = usePullRequestsStore((s) => repoPullRequests(s, repoOf(meta, git)))
  const status = usePrStatusStore((s) => s.byKey)
  const prs = useMemo(
    () => resolveLanePrs({ signals: meta.pullRequests, branch: git?.branch, slice, status }),
    [meta.pullRequests, git?.branch, slice, status],
  )
  usePrStatusRefresh(laneStatusRefs(prs))
  return prs
}

/** Resolve from this lane, never from a global workspace or machine filter. */
export function useLanePullRequests(sessionId: string, options: { all?: boolean } = {}) {
  const entry = useSessionsStore((s) => s.live[sessionId])
  const git = useSessionsStore((s) => s.gitByCwd[entry?.workspacePath ?? ''])
  // The scan's view of this lane's file: what it opened, pushed, pinned and hid.
  const meta = useSessionsStore((s) =>
    entry?.diskPath
      ? s.disk[entry.workspacePath]?.find((m) => m.path === entry.diskPath)
      : undefined,
  )
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
  const branch = (remote ? lane?.branch : git?.branch) ?? undefined
  const slice = usePullRequestsStore((s) => repoPullRequests(s, repoPath))
  const status = usePrStatusStore((s) => s.byKey)
  // A Host lane's file and gh are on its Host, which folds the one and reads through
  // the other. An older Host does neither: the lane keeps its checkout branch's PR only.
  const byNumber = remote ? ready && host?.prStatus === true : true
  const signals = remote ? lane?.pullRequests : meta?.pullRequests
  const prs = useMemo(
    () => resolveLanePrs({ signals, branch, slice, status }),
    [signals, branch, slice, status],
  )
  const revision = useMemo(
    () => ({ sessionId, streaming, lanes: host?.lanes }),
    [sessionId, streaming, host?.lanes],
  )
  useRepoPrRefresh(ready && repoPath ? [repoPath] : [], revision)
  const refs = byNumber ? laneStatusRefs(prs, options.all) : []
  useHostPrRoutes(remote ? hostLane.hostId : undefined, refs)
  usePrStatusRefresh(refs, true)
  useLaneGitInfo(remote ? undefined : entry?.workspacePath, streaming)
  return { repoPath, ready, slice, prs, lead: prs.owned[0], branch, remote }
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
