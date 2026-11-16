import { lazy, Suspense } from 'react'
import { useLaneMoveStore } from '@/stores/laneMove'
import { useRestoreWorktree, useSavedConversation } from './completionActions'

const SavedConversationModal = lazy(() =>
  import('./SavedConversationModal').then((module) => ({ default: module.SavedConversationModal })),
)
const LaneMoveHost = lazy(() =>
  import('./LaneMoveModal').then((module) => ({ default: module.LaneMoveHost })),
)
const RestoreWorktreeModal = lazy(() =>
  import('./RestoreWorktreeModal').then((module) => ({ default: module.RestoreWorktreeModal })),
)

/**
 * The "Move to…" dialog, loaded once a lane asks for it. Desktop mounts it with
 * the recovery dialogs below; the browser shell, which has no This Mac lanes
 * to recover, mounts it alone.
 */
export function LaneMoveOverlay(): React.JSX.Element | null {
  const moving = useLaneMoveStore((s) => s.draft !== null)
  return moving ? (
    <Suspense fallback={null}>
      <LaneMoveHost />
    </Suspense>
  ) : null
}

/**
 * A worktree-removed lane's saved conversation and its restore dialog, and the
 * "Move to…" dialog. Mounted once by the app, not the sidebar: the Machines
 * page, Host rows and completion notifications open them while the sidebar may
 * be hidden.
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
      <LaneMoveOverlay />
      {restoringWorktree && (
        <Suspense fallback={null}>
          <RestoreWorktreeModal />
        </Suspense>
      )}
    </>
  )
}
