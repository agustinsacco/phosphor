import { useMemo } from 'react'
import { remotePrKey } from '@shared/host-protocol-github'
import type { HostLaneView } from '@shared/ipc'
import type { SessionMeta } from '@shared/models'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { usePrInspectorStore } from '@/stores/prInspector'
import { usePrStatusStore } from '@/stores/prStatus'
import { repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'
import { alignLaneMachineFilter } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { LaneActionPr } from './laneActions'
import { resolveLanePrs, type LanePr } from './lanePrs'
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
 * A Host lane's own PRs, as the lane's pill resolves them: the checkout
 * branch's PR only, since a Host lane has no session file on this machine.
 */
export function useRemoteLanePrs(hostId: string | undefined, lane: HostLaneView): LanePr[] {
  const key = hostId ? remotePrKey(hostId, lane.repositoryId) : undefined
  const slice = usePullRequestsStore((s) => repoPullRequests(s, key))
  const status = usePrStatusStore((s) => s.byKey)
  const branch = lane.branch ?? undefined
  return useMemo(() => resolveLanePrs({ branch, slice, status }).owned, [branch, slice, status])
}
