import { useMemo } from 'react'
import { remotePrKey } from '@shared/host-protocol-github'
import type { HostLaneView } from '@shared/ipc'
import type { SessionMeta } from '@shared/models'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { usePrInspectorStore } from '@/stores/prInspector'
import { usePrStatusStore } from '@/stores/prStatus'
import { repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'
import { alignLaneMachineFilter, useRemoteLanesStore } from '@/stores/remoteLanes'
import { machineCaps } from '@/stores/machineCaps'
import { useSessionsStore } from '@/stores/sessions'
import type { LaneActionPr } from './laneActions'
import { laneStatusRefs, resolveLanePrs, type LanePr } from './lanePrs'
import { useHostPrRoutes } from './remotePullRequests'
import { usePrStatusRefresh } from './repoPrRefresh'
import { openPullRequest } from './PrBadge'
import { lanePrUrl, prMenuLabel } from './prBeads'

/** A lane's own PRs as its row menu lists them, lead first. */
export function lanePrMenuEntries(prs: LanePr[]): LaneActionPr[] {
  return prs.map((lane) => ({ key: lane.key, label: prMenuLabel(lane) }))
}

/** Opens one of the lane's PRs on GitHub, by the key its menu entry carries. */
export function openLanePr(prs: LanePr[], key: string): void {
  const lane = prs.find((item) => item.key === key)
  const url = lane && lanePrUrl(lane)
  if (url) void openPullRequest({ url })
}

/** "Show pull requests…" on a This Mac row: open the lane, then ask its pill for the inspector. */
export async function showLocalLanePullRequests(
  workspacePath: string,
  meta: SessionMeta,
): Promise<void> {
  alignLaneMachineFilter('local')
  try {
    const sessionId = await useSessionsStore.getState().openDiskSession(workspacePath, meta)
    usePrInspectorStore.getState().open(sessionId)
  } catch (error) {
    useExtensionUiStore
      .getState()
      .pushToast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/**
 * A Host lane's own PRs, as the lane's pill resolves them: the signals its Host
 * folded from the lane's file, read by number through that Host. A lane on an
 * older Host (no `prStatus`) has only its checkout branch's PR.
 */
export function useRemoteLanePrs(hostId: string | undefined, lane: HostLaneView): LanePr[] {
  const key = hostId ? remotePrKey(hostId, lane.repositoryId) : undefined
  const slice = usePullRequestsStore((s) => repoPullRequests(s, key))
  const status = usePrStatusStore((s) => s.byKey)
  const byNumber = useRemoteLanesStore((s) => {
    const host = hostId ? s.hosts[hostId] : undefined
    return host?.prStatus === true && machineCaps(host).can('workspaces.read')
  })
  const signals = byNumber ? lane.pullRequests : undefined
  const branch = lane.branch ?? undefined
  const prs = useMemo(
    () => resolveLanePrs({ signals, branch, slice, status }),
    [signals, branch, slice, status],
  )
  const refs = byNumber ? laneStatusRefs(prs) : []
  useHostPrRoutes(byNumber ? hostId : undefined, refs)
  usePrStatusRefresh(refs)
  return prs.owned
}
