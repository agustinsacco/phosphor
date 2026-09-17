import { realpathSync } from 'node:fs'
import { gitInfo } from '../fs/git-info'
import { registry } from '../registry'
import type { RoutineInput } from '@shared/routines'

/**
 * Why a folder task would be refused right now, or null when it would run.
 *
 * The runner throws on this and `routines:check` reports it as advice, so the
 * two can never disagree about what blocks a run. Both conditions are
 * transient — a tree gets committed, a session gets suspended — which is why
 * the check only warns: refusing the save would reject a schedule that is very
 * likely fine hours later when it actually fires.
 *
 * `workspacePath` must already be resolved through `realpathSync.native`, as
 * both call sites do, because the live-session comparison is by exact path.
 */
export async function folderTaskObstacle(
  workspacePath: string,
  intent: RoutineInput['intent'],
): Promise<string | null> {
  // Do not let an unattended agent mutate a folder an interactive lane owns.
  if (registry.list().some((s) => realpathSync.native(s.workspacePath) === workspacePath))
    return 'Workspace is in use by a live session. Suspend it or enable isolated worktrees.'
  // The dirty gate protects uncommitted work from an agent that writes, so only
  // a code task is refused for it. Reading a checkout you are still editing is
  // the entire point of pointing a report at one, and a fresh worktree cannot
  // do it — it branches from trunk and never sees the working tree.
  if (intent === 'code') {
    const info = await gitInfo(workspacePath)
    if (info.isRepo && info.dirtyCount)
      return (
        `Workspace has ${info.dirtyCount} uncommitted change${info.dirtyCount === 1 ? '' : 's'} ` +
        '(including untracked files). Commit or stash them, or choose a fresh Git worktree per run.'
      )
  }
  return null
}
