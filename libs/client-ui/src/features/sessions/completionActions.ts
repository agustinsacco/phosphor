import type { SessionMeta } from '@shared/models'
import { promptChoice, presentText } from '@/stores/prompt'
import { useSessionsStore } from '@/stores/sessions'
import { alignLaneMachineFilter } from '@/stores/remoteLanes'

export function openSidebarConversation(workspace: string, meta: SessionMeta): void {
  alignLaneMachineFilter('local')
  if (meta.worktreeRemoved) {
    void restoreCheckout(workspace, meta)
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

export async function restoreCheckout(workspace: string, meta: SessionMeta): Promise<void> {
  try {
    await window.phosphor.invoke('sessions:restoreWorktree', meta.cwd)
    await useSessionsStore.getState().refreshDisk(workspace)
  } catch (error) {
    await presentText({ title: 'Could not restore checkout', text: String(error) })
  }
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
            label: 'Restore worktree',
            onClick: () => {
              void restoreCheckout(workspace, meta)
            },
          },
        ]
      : []),
  ]
}
