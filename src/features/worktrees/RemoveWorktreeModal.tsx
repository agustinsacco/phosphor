import { useMemo, useState } from 'react'
import type { WorktreeInfo } from '@shared/models'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { useAsyncAction } from '@/components/useAsyncAction'
import { useSessionsStore } from '@/stores/sessions'
import { useWorktreesStore } from '@/stores/worktrees'
import { workspaceName } from '@/lib/path'

/**
 * Remove a linked worktree with the safety ladder: live-session guard →
 * clean removal → explicit "discard N changes" checkbox before force.
 * Branch deletion defaults on but only applies to a branch whose work is
 * already on the trunk (unmerged branches survive and the reason is shown).
 */
export function RemoveWorktreeModal({
  repoPath,
  worktree,
  onClose,
  onRemoved,
}: {
  repoPath: string
  worktree: WorktreeInfo
  onClose: () => void
  onRemoved?: () => void
}): React.JSX.Element {
  const live = useSessionsStore((s) => s.live)
  const [dirtyCount, setDirtyCount] = useState<number>(Math.max(0, worktree.dirtyCount))
  const [discard, setDiscard] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(true)
  const { busy, error, run } = useAsyncAction()
  const [branchNote, setBranchNote] = useState<string | null>(null)

  const liveHere = useMemo(
    () =>
      Object.values(live).some(
        (entry) =>
          entry.workspacePath === worktree.path || entry.workspacePath === worktree.realPath,
      ),
    [live, worktree],
  )

  const remove = (): Promise<void> =>
    run(async () => {
      const result = await useWorktreesStore.getState().removeWorktree(repoPath, worktree.path, {
        force: dirtyCount > 0 && discard,
        deleteBranch,
      })
      if (!result.removed) {
        // Freshly dirty (or dirtier than we thought) — surface and require
        // the discard checkbox.
        setDirtyCount(result.dirtyCount)
        setDiscard(false)
        return
      }
      if (result.branchError) {
        setBranchNote(`Worktree removed. Branch kept: ${result.branchError}`)
        return
      }
      onRemoved?.()
      onClose()
    })

  return (
    <ModalOverlay onClose={onClose}>
      <ModalPanel
        width={440}
        title="Remove worktree"
        subtitle={
          <span className="block truncate" title={worktree.path}>
            {workspaceName(worktree.path)}
            {worktree.branch ? ` — ${worktree.branch}` : ''}
          </span>
        }
        footer={
          <>
            <Button onClick={onClose}>{branchNote ? 'Done' : 'Cancel'}</Button>
            {!branchNote && (
              <Button
                variant="danger"
                onClick={() => void remove()}
                disabled={busy || liveHere || (dirtyCount > 0 && !discard)}
                className="disabled:cursor-not-allowed"
              >
                {busy ? 'Removing…' : 'Remove worktree'}
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-3 px-4 py-3 text-lg">
          {liveHere && (
            <div className="bg-warning/10 border-warning/30 text-text rounded-lg border px-3 py-2 text-base">
              A live session is running in this worktree. Close it from the sidebar first.
            </div>
          )}

          {branchNote ? (
            <div className="text-text-secondary text-base">{branchNote}</div>
          ) : dirtyCount > 0 ? (
            <div className="bg-danger-soft border-danger/25 rounded-lg border px-3 py-2.5">
              <div className="text-danger text-base font-medium">
                {dirtyCount} uncommitted change{dirtyCount === 1 ? '' : 's'} will be lost
              </div>
              <label className="mt-1.5 flex items-center gap-2 text-base">
                <input
                  type="checkbox"
                  checked={discard}
                  onChange={(e) => setDiscard(e.target.checked)}
                />
                Discard {dirtyCount} change{dirtyCount === 1 ? '' : 's'} permanently
              </label>
            </div>
          ) : (
            <div className="text-text-secondary text-base">
              The worktree is clean — the folder is removed; commits stay on the branch.
            </div>
          )}

          {worktree.branch && !branchNote && (
            <label className="flex items-center gap-2 text-base">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(e) => setDeleteBranch(e.target.checked)}
              />
              Also delete branch <span className="font-mono">{worktree.branch}</span> (only if
              merged)
            </label>
          )}

          {error && <div className="text-danger text-base">{error}</div>}
        </div>
      </ModalPanel>
    </ModalOverlay>
  )
}
