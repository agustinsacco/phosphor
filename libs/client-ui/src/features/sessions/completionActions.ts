import { create } from 'zustand'
import type { SessionMeta } from '@shared/models'
import { promptChoice, presentText } from '@/stores/prompt'
import { useSessionsStore } from '@/stores/sessions'
import { alignLaneMachineFilter } from '@/stores/remoteLanes'
import type { RecoverySource } from './worktreeRecovery'

/** Reading retained history never requires a checkout or a pi process. */
export const useSavedConversation = create<{ meta: SessionMeta | null; workspace?: string }>(
  () => ({ meta: null }),
)

/** A removed checkout being brought back. `resume` opens the conversation once it is. */
export interface RestoreTarget {
  workspace: string
  meta: SessionMeta
  resume: boolean
}
export const useRestoreWorktree = create<{ target: RestoreTarget | null }>(() => ({
  target: null,
}))

export function openRestoreWorktree(workspace: string, meta: SessionMeta, resume = false): void {
  useRestoreWorktree.setState({ target: { workspace, meta, resume } })
}

export function openSidebarConversation(workspace: string, meta: SessionMeta): void {
  alignLaneMachineFilter('local')
  if (meta.worktreeRemoved) {
    useSavedConversation.setState({ meta, workspace })
    return
  }
  void useSessionsStore.getState().openDiskSession(workspace, meta)
}

async function changeCompletion(workspace: string, meta: SessionMeta): Promise<void> {
  try {
    const complete = !meta.completedAt
    if (
      complete &&
      (await promptChoice({
        title: 'Finish conversation?',
        message:
          'This conversation will become eligible for worktree cleanup after the grace period. Other unfinished or pinned conversations still protect this checkout. History is retained.',
        choices: [{ value: 'finish', label: 'Finish conversation', primary: true }],
      })) !== 'finish'
    )
      return
    await window.phosphor.invoke('sessions:setCompleted', meta.path, complete)
    await useSessionsStore.getState().refreshDisk(workspace)
  } catch (error) {
    await presentText({ title: 'Conversation kept', text: String(error) })
  }
}

/** Throws so the modal can show the failure in place and stay open. */
export async function restoreCheckout(
  { workspace, meta, resume }: RestoreTarget,
  source: RecoverySource,
): Promise<void> {
  if (source === 'saved') await window.phosphor.invoke('sessions:restoreWorktree', meta.cwd)
  else await window.phosphor.invoke('sessions:recreateWorktree', meta.cwd, source)
  const sessions = useSessionsStore.getState()
  await sessions.refreshDisk(workspace)
  if (!resume) return
  useSavedConversation.setState({ meta: null })
  await sessions.openDiskSession(workspace, { ...meta, worktreeRemoved: false })
}

export function completionActions(workspace: string, meta: SessionMeta) {
  return [
    {
      label: meta.completedAt ? 'Reopen conversation' : 'Finish conversation…',
      onClick: () => {
        void changeCompletion(workspace, meta)
      },
    },
    ...(meta.worktreeRemoved
      ? [
          {
            label: 'Restore worktree…',
            onClick: () => openRestoreWorktree(workspace, meta),
          },
        ]
      : []),
  ]
}
