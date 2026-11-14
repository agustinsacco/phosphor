import { parseLaneArchiveOp } from '@phosphor/shared/lane-archive'
import { dispatch } from './queue'
import { rejected, terminal } from './receipts'
import { handled, NOT_MATCHED, type Routed } from './routing'
import type { CommandState, Job, LaneCommandPorts, LaneQueue } from './state'

/** Archived resources are machine-scoped; active-lane archive still uses lane admission/fencing. */
export function executeArchive(
  state: CommandState,
  ports: LaneCommandPorts,
  job: Job,
  queue: LaneQueue,
  allowed: () => boolean,
): Routed {
  const op = parseLaneArchiveOp(job.frame.op)
  if (!op || op.type === 'lane.archive') return NOT_MATCHED
  if (!ports.archives) {
    rejected(state, ports, job, 'unsupported', true)
    return handled()
  }
  if (job.frame.laneId !== undefined || job.frame.fence !== undefined) {
    rejected(state, ports, job, 'bad-request', true)
    return handled()
  }
  const archives = ports.archives
  const { requestId } = job.frame
  const completion = dispatch(state, ports, job, queue, () => archives.execute(op, allowed)).then(
    (result) => {
      if (!result.answered)
        return terminal(state, ports, job, { requestId, status: 'unknown' }, true)
      if (!result.value.ok) return rejected(state, ports, job, result.value.code, true)
      terminal(state, ports, job, { requestId, status: 'done', data: result.value.data }, true)
    },
  )
  return handled({ completion, detached: false })
}
