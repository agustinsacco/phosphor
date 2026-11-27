import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { gitInfo } from '../git/git-info'
import { validateRoutine, type RoutineInput } from '@shared/routines'

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
  occupied: (path: string) => boolean,
): Promise<string | null> {
  // Do not let an unattended agent mutate a folder an interactive lane owns.
  if (occupied(workspacePath))
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

export async function readRoutineInput(raw: unknown): Promise<RoutineInput> {
  const r = validateRoutine(raw)
  if (!isAbsolute(r.workspacePath) || !(await stat(r.workspacePath)).isDirectory())
    throw new Error('Choose an existing absolute workspace folder.')
  return { ...r, workspacePath: await realpath(r.workspacePath) }
}

export async function checkRoutine(
  input: RoutineInput,
  checkPi: () => Promise<void> | void,
  occupied: (path: string) => boolean,
) {
  await checkPi()
  if (input.isolated && !(await gitInfo(input.workspacePath)).isRepo)
    throw new Error(
      'Worktree isolation requires a Git repository. Choose Folder task for analysis outside Git.',
    )
  return {
    summary:
      'Folder and pi checked. Model identity is verified at execution. Connector access, account limits, and task results require a real test run, which can have side effects.',
    warning: input.isolated
      ? null
      : await folderTaskObstacle(input.workspacePath, input.intent, occupied),
  }
}
