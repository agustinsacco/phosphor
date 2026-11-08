import { useState } from 'react'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { MenuRow } from '@/components/PopupMenu'
import { promptRenameSandbox } from '@/features/workspaces/promptRenameSandbox'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import type { GitInfo, WorktreeInfo } from '@shared/models'
import type { GroupedSessions } from './groupSessions'

/** The worktree confirm a This Mac group header opens. */
export interface LocalWorktreeModal {
  kind: 'remove' | 'merge'
  repoPath: string
  worktree: WorktreeInfo
}

/**
 * A This Mac group's own ⋯ menu rows, the mirror of `RemoteFolderMenuRows`:
 * move it within the sidebar's order, then remove it (or, for a sandbox,
 * rename or delete it). Both removals confirm in place, on a second click.
 */
export function LocalFolderMenuRows({
  group,
  first,
  last,
  onDone,
}: {
  group: GroupedSessions
  first: boolean
  last: boolean
  /** Closes the menu. */
  onDone: () => void
}): React.JSX.Element {
  const sandbox = useWorkspacesStore((s) => s.sandboxes.some((b) => b.path === group.workspacePath))
  const move = (direction: 'up' | 'down'): void => {
    // A merged worktree group is represented by its main-repo workspace path,
    // which is the entry the user sees and orders in the sidebar.
    useWorkspacesStore.getState().moveWorkspace(group.workspacePath, direction)
    onDone()
  }
  return (
    <>
      <MenuRow active={false} disabled={first} onClick={() => move('up')}>
        Move up
      </MenuRow>
      <MenuRow active={false} disabled={last} onClick={() => move('down')}>
        Move down
      </MenuRow>
      {/* Only a sandbox is renamed or deleted from here: it is Phosphor's own
        scratch folder, so its name and its removal are ours to offer. A
        project folder is the user's, so it is only ever forgotten: it leaves
        the sidebar and nothing on disk changes. This used to be Settings-only,
        and people could not find it. */}
      {sandbox ? (
        <SandboxRows workspacePath={group.workspacePath} onDone={onDone} />
      ) : (
        <RemoveFromSidebarRow group={group} onDone={onDone} />
      )}
    </>
  )
}

function RemoveFromSidebarRow({
  group,
  onDone,
}: {
  group: GroupedSessions
  onDone: () => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  return (
    <MenuRow
      active={false}
      testId="workspace-group-remove"
      onClick={() => {
        // Second click confirms, in place, like a sandbox delete: it is undone
        // by opening the folder again.
        if (!confirming) {
          setConfirming(true)
          return
        }
        onDone()
        void useWorkspacesStore
          .getState()
          .removeWorkspace([
            group.workspacePath,
            ...group.paths.filter((path) => path !== group.workspacePath),
          ])
      }}
    >
      <span className={confirming ? 'text-danger' : ''}>
        {confirming ? 'Remove? Files stay on disk' : 'Remove from sidebar'}
      </span>
    </MenuRow>
  )
}

function SandboxRows({
  workspacePath,
  onDone,
}: {
  workspacePath: string
  onDone: () => void
}): React.JSX.Element {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  return (
    <>
      <MenuRow
        active={false}
        testId="workspace-group-rename-sandbox"
        onClick={() => {
          onDone()
          void promptRenameSandbox(workspacePath)
        }}
      >
        Rename sandbox…
      </MenuRow>
      <MenuRow
        active={false}
        testId="workspace-group-delete-sandbox"
        onClick={() => {
          // Second click confirms, in place — a sandbox goes to the Trash, so a
          // modal would cost more than the mistake it prevents.
          if (!confirmingDelete) {
            setConfirmingDelete(true)
            return
          }
          onDone()
          void useWorkspacesStore.getState().deleteSandbox(workspacePath)
        }}
      >
        <span className={confirmingDelete ? 'text-danger' : ''}>
          {confirmingDelete ? 'Delete, with its chats?' : 'Delete sandbox…'}
        </span>
      </MenuRow>
    </>
  )
}

/** Open a new session in this group's folder. */
export function startLocalSession(workspacePath: string): void {
  useWorkspacesStore.getState().openWorkspace(workspacePath)
  useSessionsStore.getState().activate(null)
}

/**
 * A This Mac group header's right-click menu: New session, and for a group
 * whose own folder is a worktree, Merge into main… and Remove worktree….
 */
export function localGroupMenuItems(
  group: GroupedSessions,
  git: GitInfo | undefined,
  openWorktreeModal: (modal: LocalWorktreeModal) => void,
): ContextMenuItem[] {
  const openWorktree = async (kind: 'remove' | 'merge'): Promise<void> => {
    const repoPath = git?.mainRepoPath
    if (!repoPath) return
    const worktrees = await window.phosphor.invoke('git:listWorktrees', repoPath)
    const worktree = worktrees.find(
      (w) => w.path === group.workspacePath || w.realPath === group.workspacePath,
    )
    if (worktree) openWorktreeModal({ kind, repoPath, worktree })
  }
  return [
    { label: 'New session', onClick: () => startLocalSession(group.workspacePath) },
    // Only offered when the group's own representative folder is itself a
    // worktree — i.e. its main repo isn't a known workspace to fold into.
    // Once both are known and merged, this lives on the top bar's branch
    // control instead of the ambiguous, multi-folder group.
    ...(git?.isWorktree && git.mainRepoPath
      ? [
          {
            label: 'Merge into main…',
            separatorAbove: true,
            onClick: () => void openWorktree('merge'),
          },
          {
            label: 'Remove worktree…',
            danger: true,
            onClick: () => void openWorktree('remove'),
          },
        ]
      : []),
  ]
}
