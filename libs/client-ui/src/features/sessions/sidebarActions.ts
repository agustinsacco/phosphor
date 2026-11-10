import type { LaneMoveMarks } from '@shared/host-protocol-lane-transfer'
import type { LaneMoveSource } from '@shared/lane-move'
import type { SessionMeta } from '@shared/models'
import { laneMarker } from '@/lib/laneMarker'
import { useChatStore } from '@/stores/chat'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useLaneMoveStore } from '@/stores/laneMove'
import { useSessionsStore } from '@/stores/sessions'
import { changeSessionBranch } from './sessionTransition'
import { exportSessionHtml, applySessionRename } from './sessionActions'

/**
 * Sidebar row actions. These wrap the shared session actions with the
 * open-disk-session-first step the sidebar needs, since a row may refer to a
 * session that has no live pi process yet.
 */

export async function renameSidebarSession(
  workspacePath: string,
  meta: SessionMeta,
  name: string,
  livePhosphorId?: string,
): Promise<void> {
  const store = useSessionsStore.getState()
  const phosphorId = livePhosphorId ?? (await store.openDiskSession(workspacePath, meta))
  if (await applySessionRename(phosphorId, name)) void store.refreshDisk(workspacePath)
}

export async function cloneSession(
  workspacePath: string,
  meta: SessionMeta,
  livePhosphorId?: string,
): Promise<void> {
  if (livePhosphorId) {
    await changeSessionBranch(livePhosphorId, { type: 'clone' })
  } else {
    await useSessionsStore.getState().createSession(workspacePath, { forkFrom: meta.path })
  }
}

/** Export a disk or live session to HTML, opening it first if needed. */
export async function exportSidebarSession(
  workspacePath: string,
  meta: SessionMeta,
  livePhosphorId?: string,
): Promise<void> {
  const store = useSessionsStore.getState()
  const phosphorId = livePhosphorId ?? (await store.openDiskSession(workspacePath, meta))
  await exportSessionHtml(phosphorId, meta.name ?? 'session')
}

/** Open "Move to…" for a lane, carrying the pin and marker the user sees on it. */
export function openLaneMove(source: LaneMoveSource, title: string, marks: LaneMoveMarks): void {
  useLaneMoveStore.getState().open({ source, title, marks })
}

/**
 * Open "Move to…" for a This Mac lane, stopping its idle session first: the
 * move copies the saved transcript, and main refuses a live one. A turn that
 * began since the menu opened, or a stop that fails, leaves it live; the
 * dialog's check then says why.
 * Carry the visible marker explicitly so a new folder or branch cannot change it.
 */
export async function moveSidebarSession(
  meta: SessionMeta,
  branch: string | null | undefined,
  livePhosphorId?: string,
): Promise<void> {
  if (livePhosphorId && !useChatStore.getState().sessions[livePhosphorId]?.isStreaming)
    await useSessionsStore
      .getState()
      .suspendSession(livePhosphorId)
      .catch(() => undefined)
  const { pinned, laneMarkers } = useSessionsStore.getState()
  openLaneMove({ machine: 'local', sessionPath: meta.path }, meta.name ?? 'Lane', {
    pinned: pinned.includes(meta.path),
    marker: laneMarker(
      laneMarkers[meta.path],
      branch,
      meta.cwd,
      useLanePrefsStore.getState().lanes.markers,
    ),
  })
}
