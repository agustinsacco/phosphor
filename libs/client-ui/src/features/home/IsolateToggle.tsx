import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { TooltipLabel, tooltipProps } from '@/components/Tooltip'
import { useWorktreesStore } from '@/stores/worktrees'

/**
 * Per-chat opt-out from branch isolation, next to the message it applies to.
 *
 * The same preference as the branch popup's "worktree" checkbox and the
 * Workspaces settings switch — deliberately one flag in three places rather
 * than three flags, since all three answer "does my work get its own branch?".
 * It lives here because the answer is worth changing per message: a quick
 * question does not deserve a branch, and the composer is where you know that.
 *
 * This Mac only: a Host lane always gets a worktree, so its composer has no toggle.
 */
export function IsolateToggle({
  checked,
  disabled,
  workspacePath,
}: {
  checked: boolean
  disabled: boolean
  workspacePath: string
}): React.JSX.Element {
  const trunk = useStartPoint(workspacePath)
  return (
    <TooltipLabel
      {...tooltipProps(
        checked
          ? {
              label: `New worktree off ${trunk ?? 'main'}`,
              description: 'Not the folder shown beside it',
            }
          : { label: 'Run in the open folder', description: 'On its current branch' },
      )}
      className={clsx(
        'flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors',
        disabled ? 'opacity-50' : 'hover:bg-bg-secondary',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => useWorktreesStore.getState().setPreferWorktree(e.target.checked)}
        className="accent-[var(--px-accent)]"
      />
      {/*
        Names the base, not just the mode. "new branch" alone left the only
        other branch on the row — the chip beside it, which shows the folder's
        CURRENT branch — looking like the answer to "off what?", when
        `startChat` ignores it entirely and always branches from trunk.
      */}
      <span className="text-text-secondary text-base">
        {checked && trunk ? `new branch off ${trunk}` : 'new branch'}
      </span>
    </TooltipLabel>
  )
}

/**
 * The trunk a new chat's branch will start from, or null while unknown.
 *
 * Read from `git:startPoint`, the same call `startChat` makes, so the label
 * and the behaviour cannot disagree.
 */
function useStartPoint(workspacePath: string): string | null {
  const [trunk, setTrunk] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.phosphor
      .invoke('git:startPoint', workspacePath)
      .then((point) => {
        if (!cancelled) setTrunk(point.defaultBranch)
      })
      // Unresolvable trunk means `startChat` falls back to HEAD; the label
      // then says plain "new branch", which stays true.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspacePath])
  return trunk
}
