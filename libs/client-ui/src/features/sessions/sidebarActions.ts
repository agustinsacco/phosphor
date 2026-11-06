import type { SessionMeta } from '@shared/models'
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

/** Mark a lane read without opening it: its activity is seen, its unread count cleared. */
export function markSidebarSessionRead(sessionPath: string, livePhosphorId?: string): void {
  const store = useSessionsStore.getState()
  store.markSeen(sessionPath)
  if (livePhosphorId && store.unread[livePhosphorId])
    useSessionsStore.setState((s) => ({ unread: { ...s.unread, [livePhosphorId]: 0 } }))
}
