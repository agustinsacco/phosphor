import type { LaneMoveMarks } from '@shared/host-protocol-lane-transfer'
import type { LaneMoveSource } from '@shared/lane-move'
import type { SessionMeta } from '@shared/models'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { laneMarker } from '@/lib/laneMarker'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useLaneMoveStore } from '@/stores/laneMove'
import { useSessionsStore } from '@/stores/sessions'
import { STOP_BEFORE_MOVE } from './remoteLaneActions'
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
 * A row's two copy actions. Move makes its visible marker explicit so moving
 * to another folder or changing branches cannot change the copy's icon.
 */
export function copyActions(
  workspacePath: string,
  meta: SessionMeta,
  livePhosphorId: string | undefined,
  branch: string | null | undefined,
): ContextMenuItem[] {
  const move = () => {
    const { pinned, laneMarkers } = useSessionsStore.getState()
    openLaneMove({ machine: 'local', sessionPath: meta.path }, meta.name ?? 'Lane', {
      pinned: pinned.includes(meta.path),
      marker: laneMarker(laneMarkers[meta.path], branch, meta.cwd, useLanePrefsStore.getState().lanes.markers),
    })
  }
  return [
    { label: 'Clone', onClick: () => void cloneSession(workspacePath, meta, livePhosphorId) },
    {
      label: 'Move to…',
      disabled: !!livePhosphorId,
      ...(livePhosphorId ? { hint: STOP_BEFORE_MOVE } : {}),
      onClick: move,
    },
  ]
}
