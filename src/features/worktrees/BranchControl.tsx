import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { GitInfo, WorktreeInfo } from '@shared/models'
import { BranchIcon, ChevronIcon } from '@/components/icons'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { revealLabel } from '@/lib/reveal'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { repoWorktrees, useWorktreesStore } from '@/stores/worktrees'
import { MergeWorktreeModal } from './MergeWorktreeModal'
import { RemoveWorktreeModal } from './RemoveWorktreeModal'
import { BranchPicker } from './BranchPicker'
import { PrRow } from './PrRow'
import { workspaceName } from '@/lib/path'
import { useWorkspaceNameTransition } from '@/features/sessions/nameTransition'

/**
 * The top bar's branch control: which branch this workspace is on, and the
 * single place to move to another one.
 *
 * Replaces the chat header's `GitChips`. Same job, but living in the window's
 * one persistent bar means it is reachable from the home screen and from a
 * session alike — previously worktree controls existed in the home composer
 * and the chat header separately, and neither was visible from the other.
 */
export function BranchControl({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element | null {
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [mergeTarget, setMergeTarget] = useState<WorktreeInfo | null>(null)
  const [removeTarget, setRemoveTarget] = useState<WorktreeInfo | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = (): void => {
      void window.phosphor.invoke('git:info', workspacePath).then(setInfo)
    }
    refresh()
    void window.phosphor.invoke('fs:watchWorkspace', workspacePath)
    const unsubscribe = window.phosphor.onFsChanged((payload) => {
      if (payload.workspacePath !== workspacePath) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, 500)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [workspacePath])

  // In a worktree the repo of record is the main tree; in the main tree it is
  // this workspace. Either way the menu operates on the same repo, which is
  // what makes main -> worktree and worktree -> main both reachable.
  const mainRepo = info?.mainRepoPath
  const repoPath = info?.isWorktree && mainRepo ? mainRepo : workspacePath

  /**
   * Fetch on workspace open, not just on menu open, so "your main is 12 behind"
   * is already true the first time the chip is looked at rather than only after
   * the user thinks to click it. Throttled per repo in the main process.
   */
  useEffect(() => {
    if (!info?.isRepo) return
    void useWorktreesStore.getState().syncRemote(repoPath)
  }, [info?.isRepo, repoPath])

  /**
   * Re-read after any worktree-store mutation — rename, checkout, add, remove.
   *
   * The fs watcher above cannot cover these: they all write inside `.git`,
   * which `fs:watchWorkspace` does not report, so the chip kept displaying
   * whatever `git:info` said when the workspace was opened. That was invisible
   * until branches started being renamed under a live session (a chat's branch
   * is cut from a slug and retitled once its name arrives), which left the chip
   * naming a branch that no longer existed.
   */
  const repoLoadedAt = useWorktreesStore((s) => repoWorktrees(s, repoPath).loadedAt)
  useEffect(() => {
    if (repoLoadedAt === 0) return
    void window.phosphor.invoke('git:info', workspacePath).then(setInfo)
  }, [repoLoadedAt, workspacePath])

  /**
   * A branch about to be renamed says so.
   *
   * An auto-created chat branch starts as a slug of the first message and is
   * renamed once the chat's generated name arrives. A branch name silently
   * changing under the user is alarming — this is the one surface where that
   * shows — so it shimmers while the rename is still possible and animates the
   * new name in when it happens.
   */
  const naming = useWorkspaceNameTransition(workspacePath)

  if (!info?.isRepo || !info.branch) return null

  const openWorkspaceAt = (cwd: string): void => {
    setOpen(false)
    useWorkspacesStore.getState().openWorkspace(cwd)
    useSessionsStore.getState().activate(null)
  }

  const openMergeModal = async (): Promise<void> => {
    if (!mainRepo) return
    setOpen(false)
    const worktrees = await window.phosphor.invoke('git:listWorktrees', mainRepo)
    const here = worktrees.find((w) => w.path === workspacePath || w.realPath === workspacePath)
    if (here) setMergeTarget(here)
  }

  const behind = info.behind ?? 0

  return (
    <span className="relative shrink-0">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        title={
          naming.pending
            ? `${info.branch} — provisional, renamed once this chat is named`
            : info.isWorktree && mainRepo
              ? `Worktree of ${mainRepo}`
              : `Branch ${info.branch}`
        }
        data-testid="branch-chip"
        aria-expanded={open}
        className={clsx(
          'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-sm transition-colors',
          open
            ? 'bg-bg-secondary text-text'
            : 'bg-bg-secondary text-text-secondary hover:text-text',
        )}
      >
        {info.isWorktree && (
          <span className="bg-accent-soft text-accent rounded px-1 text-2xs font-medium">wt</span>
        )}
        <BranchIcon size={10} />
        <span
          key={info.branch}
          className={clsx(
            'max-w-36 truncate',
            // Arrival only. The pending state is carried by the tooltip above
            // rather than by motion: this chip sits in the same bar as the
            // session title, and two things shimmering side by side there was
            // the bulk of the "everything animates on send" complaint.
            naming.settled && 'name-enter',
          )}
        >
          {info.branch}
        </span>
        {(info.ahead ?? 0) > 0 && <span className="text-success">↑{info.ahead}</span>}
        {behind > 0 && (
          <span className="text-info" title={`${behind} commits behind the remote — open to pull`}>
            ↓{behind}
          </span>
        )}
        {(info.dirtyCount ?? 0) > 0 && <span className="text-warning">·{info.dirtyCount}</span>}
        <ChevronIcon size={10} className="text-text-tertiary" />
      </button>

      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fitViewport
          className="absolute left-0 top-full z-40 mt-1.5 max-h-[32rem] w-80 max-w-[calc(100vw-16rem)] overflow-y-auto py-1.5"
        >
          <div className="px-3 pb-1.5 pt-1">
            <div className="text-text truncate text-lg font-medium">{info.branch}</div>
            <div className="text-text-secondary mt-0.5 text-base">
              {(info.dirtyCount ?? 0) > 0
                ? `${info.dirtyCount} uncommitted change${info.dirtyCount === 1 ? '' : 's'}`
                : 'Working tree clean'}
              {info.isWorktree && mainRepo && ` · worktree of ${workspaceName(mainRepo)}`}
            </div>
          </div>
          <PrRow repoPath={repoPath} branch={info.branch} />
          <div className="border-border my-1 border-t" />

          <BranchPicker
            repoPath={repoPath}
            currentCwd={info.isWorktree ? workspacePath : null}
            mainBranch={info.isWorktree ? undefined : info.branch}
            onSelectMain={() => openWorkspaceAt(repoPath)}
            onSelectWorktree={(wt) => openWorkspaceAt(wt.realPath)}
            onRemove={(wt) => {
              setOpen(false)
              setRemoveTarget(wt)
            }}
          />

          <div className="border-border my-1 border-t" />
          {info.isWorktree && mainRepo && (
            <MenuRow active={false} onClick={() => void openMergeModal()}>
              <span className="text-lg">Merge into main…</span>
            </MenuRow>
          )}
          <MenuRow
            active={false}
            onClick={() => {
              setOpen(false)
              void window.phosphor.invoke('app:revealPath', workspacePath)
            }}
          >
            <span className="text-lg">{revealLabel()}</span>
          </MenuRow>
        </PopupMenu>
      )}

      {removeTarget && (
        <RemoveWorktreeModal
          repoPath={repoPath}
          worktree={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => {
            // The session's own worktree just went away; fall back to the repo.
            if (removeTarget.realPath === workspacePath) openWorkspaceAt(repoPath)
          }}
        />
      )}

      {mergeTarget && mainRepo && (
        <MergeWorktreeModal
          repoPath={mainRepo}
          worktree={mergeTarget}
          onClose={() => setMergeTarget(null)}
        />
      )}
    </span>
  )
}
