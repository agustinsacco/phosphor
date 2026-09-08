import type { SessionMeta } from '@shared/models'
import { bootstrapSession, useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { piCall } from '@/lib/rpc'
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
  livePidexId?: string,
): Promise<void> {
  const store = useSessionsStore.getState()
  const pidexId = livePidexId ?? (await store.openDiskSession(workspacePath, meta))
  if (await applySessionRename(pidexId, name)) void store.refreshDisk(workspacePath)
}

export async function cloneSession(
  workspacePath: string,
  meta: SessionMeta,
  livePidexId?: string,
): Promise<void> {
  if (livePidexId) {
    // The `success &&` guard used to swallow the failure branch entirely, so a
    // clone that never happened still refreshed the sidebar and looked done.
    const result = await piCall(livePidexId, { type: 'clone' })
    if (!result) return
    if (result.cancelled) {
      useChatStore.getState().setError(livePidexId, 'Clone was cancelled by an extension.')
      return
    }
    // pi's `clone` is a same-file-branching `fork` under the hood, so it
    // swaps this live session onto the new file too — relearn it (see
    // bootstrapSession's doc comment), or `live.diskPath` keeps pointing at
    // the pre-clone file and the sidebar tracks the wrong row as live.
    await bootstrapSession(livePidexId)
    // A clone gets a new pi session id, which orphans a pi-claude-cli
    // session's CLI counterpart — the provider's next turn would reimport the
    // whole conversation as a full-context cache write. Fork the CLI ledger
    // onto the new id first. Awaited so the pairing is on disk before the
    // user can send the clone's first prompt; a false result is the normal
    // not-a-Claude-session case, so it is not surfaced.
    const clonePath = useSessionsStore.getState().live[livePidexId]?.diskPath
    if (clonePath) await window.pidex.invoke('sessions:forkClaudeLedger', clonePath)
    void useSessionsStore.getState().refreshDisk(workspacePath)
  } else {
    await useSessionsStore.getState().createSession(workspacePath, { forkFrom: meta.path })
  }
}

/** Export a disk or live session to HTML, opening it first if needed. */
export async function exportSidebarSession(
  workspacePath: string,
  meta: SessionMeta,
  livePidexId?: string,
): Promise<void> {
  const store = useSessionsStore.getState()
  const pidexId = livePidexId ?? (await store.openDiskSession(workspacePath, meta))
  await exportSessionHtml(pidexId, meta.name ?? 'session')
}
