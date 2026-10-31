import { git } from '@phosphor/session-runtime/git/git-exec'
import { isLaneBranchName } from '@phosphor/shared/host-protocol'
import type { SessionPush } from '@phosphor/shared/models'
import type { Binding, RuntimeLaneState } from './state'

/** The branch checked out in `cwd`; null when HEAD is detached or `cwd` is not a repository. */
export async function checkedOutBranch(cwd: string): Promise<string | null> {
  const name = await git(cwd, ['symbolic-ref', '--short', 'HEAD'], {
    allowFail: true,
    trim: true,
    isolateEnv: true,
  })
  return isLaneBranchName(name) ? name : null
}

/** A finished run, the moment a branch switch inside it has happened. */
export function runEnded(push: SessionPush): boolean {
  return push.kind === 'event' && push.event.type === 'agent_end' && !push.event.willRetry
}

/**
 * A lane's branch follows its folder.
 *
 * The Host records the branch when it creates the lane, but the agent (or a
 * terminal) can switch, create or rename the branch checked out there. Desktop's
 * own lanes read the branch live; this keeps a Host lane's summary in step, read
 * when the lane attaches and after every run. A detached or unreadable HEAD keeps
 * the last branch named, so a rebase in progress does not blank the row.
 */
export async function syncBranch(context: RuntimeLaneState, binding: Binding): Promise<void> {
  const { store } = context.options
  const laneId = binding.laneId
  try {
    const lane = laneId === undefined ? null : store.getLane(laneId)
    if (!laneId || !lane || lane.removedAt !== null) return
    const branch = await checkedOutBranch(lane.cwd)
    const current = store.getLane(laneId)
    if (branch === null || binding.laneId !== laneId || current?.removedAt !== null) return
    if (current.branch === branch) return
    store.updateLane(laneId, { branch })
    await binding.attachment?.stateChanged()
  } catch {
    try {
      context.options.log('host', 'lane.branch_sync_failed', { laneId })
    } catch {
      // A display refresh cannot fail a run.
    }
  }
}
