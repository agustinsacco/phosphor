import { lazy, Suspense } from 'react'
import { useRestoreWorktree, useSavedConversation } from './completionActions'

const SavedConversationModal = lazy(() =>
  import('./SavedConversationModal').then((module) => ({ default: module.SavedConversationModal })),
)
const RestoreWorktreeModal = lazy(() =>
  import('./RestoreWorktreeModal').then((module) => ({ default: module.RestoreWorktreeModal })),
)

/**
 * A worktree-removed lane's saved conversation and its restore dialog. Mounted
 * once by the app, not the sidebar: the Machines page and completion
 * notifications open them while the sidebar may be hidden.
 */
export function SessionRecoveryModals(): React.JSX.Element {
  const savedConversation = useSavedConversation((s) => s.meta)
  const restoringWorktree = useRestoreWorktree((s) => s.target)
  return (
    <>
      {savedConversation && (
        <Suspense fallback={null}>
          <SavedConversationModal />
        </Suspense>
      )}
      {restoringWorktree && (
        <Suspense fallback={null}>
          <RestoreWorktreeModal />
        </Suspense>
      )}
    </>
  )
}
