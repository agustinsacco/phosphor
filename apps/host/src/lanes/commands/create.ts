import { normalizeLabel } from '@phosphor/shared/control-api'
import { HOST_LIMITS, type LaneOp } from '@phosphor/shared/host-protocol'
import { createLane } from '../create'
import { LaneCapacityReached, type HostStore, type StoredLane } from '../store'
import { LaneFolderError } from '../worktree'
import { dispatch, drain, publish, queueFor } from './queue'
import { log, rejected, terminal, type ReceiptPorts } from './receipts'
import type {
  Answer,
  CommandState,
  ExecuteJob,
  Execution,
  Job,
  LaneCommandPorts,
  LaneQueue,
} from './state'

export type CreateOp = Extract<LaneOp, { type: 'lane.create' }>
export type CreatePorts = ReceiptPorts &
  Pick<LaneCommandPorts, 'store' | 'sessions' | 'publish' | 'summaryFor'>
/** What the creation work settled to. The receipt path maps it once it is answered. */
export type CreationResult =
  | { kind: 'created'; lane: StoredLane }
  | { kind: 'capacity' }
  | { kind: 'branch-exists' }
  | { kind: 'failed'; error: { code: 'internal'; message: string } }
  | { kind: 'closed' }
/**
 * One creation's state. Once the lane row is stored, its queue is held (and kept
 * from cleanup under its lane id) until attachment and the first publications end.
 */
export interface Creation {
  hold?: { laneId: string; queue: LaneQueue }
}

/** The repository root to create in, or the refusal recorded before any folder work. */
export function validateCreate(
  store: Pick<HostStore, 'listRepositories' | 'listLanes' | 'limits'>,
  laneId: string | undefined,
  op: CreateOp,
): { ok: true; root: string } | { ok: false; code: 'bad-request' | 'too-many-requests' } {
  const repository = store.listRepositories().find((entry) => entry.id === op.repositoryId)
  if (
    laneId !== undefined ||
    !repository ||
    (op.provider !== undefined && op.provider.length > 64) ||
    (op.model !== undefined && op.model.length > 128) ||
    (op.name !== undefined &&
      (op.name.length > HOST_LIMITS.labelChars || normalizeLabel(op.name) !== op.name))
  )
    return { ok: false, code: 'bad-request' }
  if (store.listLanes().length >= store.limits.lanesPerHost)
    return { ok: false, code: 'too-many-requests' }
  return { ok: true, root: repository.path }
}

export function holdCreatedLane(state: CommandState, creation: Creation, laneId: string): void {
  const queue = queueFor(state, laneId)
  queue.holds++
  creation.hold = { laneId, queue }
}

/** Release the hold and drain whatever queued on the new lane meanwhile. */
export function releaseCreatedLane(
  state: CommandState,
  ports: ReceiptPorts,
  execute: ExecuteJob,
  creation: Creation,
): void {
  const hold = creation.hold
  if (!hold) return
  hold.queue.holds--
  if (!hold.queue.draining)
    void drain(state, ports, execute, hold.laneId, hold.queue).catch(() => {})
}

/** Classify a createLane failure. Only a token-shaped error code is logged. */
export function creationFailure(
  ports: Pick<LaneCommandPorts, 'log'>,
  requestId: string,
  error: unknown,
): CreationResult {
  if (error instanceof LaneCapacityReached) return { kind: 'capacity' }
  if (error instanceof LaneFolderError && error.code === 'branch-exists')
    return { kind: 'branch-exists' }
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (typeof code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(code))
    log(ports, 'lane.command_error', { requestId, op: 'lane.create', code })
  return {
    kind: 'failed',
    error: {
      code: 'internal',
      message: error instanceof LaneFolderError ? error.message : 'the lane could not start',
    },
  }
}

/** Control fence 1, then the summary, on the held queue so a failed control is owed. */
export function publishCreated(
  state: CommandState,
  ports: CreatePorts,
  lane: StoredLane,
  queue: LaneQueue,
): void {
  publish(state, ports, lane.laneId, { kind: 'control', control: lane.control }, queue)
  const summary = ports.summaryFor(lane.laneId)
  if (summary) publish(state, ports, lane.laneId, { kind: 'summary', summary }, queue)
}

export async function runCreation(
  state: CommandState,
  ports: CreatePorts,
  job: Job,
  input: { op: CreateOp; root: string; creation: Creation; execute: ExecuteJob },
): Promise<CreationResult> {
  const { client, frame } = job
  const { op, root, creation } = input
  try {
    let lane: StoredLane
    try {
      lane = await createLane(
        { ...ports, closed: () => state.closed },
        {
          root,
          op,
          controller: { clientId: client.id, label: client.label },
          onStored: (laneId) => holdCreatedLane(state, creation, laneId),
        },
      )
    } catch (error) {
      return creationFailure(ports, frame.requestId, error)
    }
    if (state.closed) return { kind: 'closed' }
    if (!creation.hold) throw new Error('missing lane queue')
    publishCreated(state, ports, lane, creation.hold.queue)
    return { kind: 'created', lane }
  } finally {
    releaseCreatedLane(state, ports, input.execute, creation)
  }
}

export function mapCreationReceipt(
  state: CommandState,
  ports: ReceiptPorts,
  job: Job,
  result: Answer<CreationResult>,
): void {
  const { requestId } = job.frame
  if (!result.answered)
    return terminal(state, ports, job, { requestId, status: 'unknown' }, true, result.reason)
  const outcome = result.value
  switch (outcome.kind) {
    case 'capacity':
      return rejected(state, ports, job, 'too-many-requests', true)
    case 'branch-exists':
      return rejected(state, ports, job, 'branch-exists', true)
    case 'failed':
      return terminal(
        state,
        ports,
        job,
        { requestId, status: 'failed', error: outcome.error },
        true,
      )
    case 'created':
      return terminal(
        state,
        ports,
        job,
        { requestId, status: 'done', laneId: outcome.lane.laneId, fence: 1 },
        true,
      )
    case 'closed':
      // Closed answers nothing; the queue's unknown for this throw is dropped too.
      throw new Error('missing lane')
  }
}

/**
 * lane.create on the machine queue. Its completion waits for both the receipt and
 * the work, so a timed-out creation still holds the queue until rollback settles.
 */
export function executeCreate(
  state: CommandState,
  ports: CreatePorts,
  job: Job,
  queue: LaneQueue,
  input: { op: CreateOp; execute: ExecuteJob },
): Execution | void {
  const valid = validateCreate(ports.store, job.frame.laneId, input.op)
  if (!valid.ok) return rejected(state, ports, job, valid.code, true)
  const creation: Creation = {}
  const work = runCreation(state, ports, job, { ...input, root: valid.root, creation })
  const receiptPath = dispatch(state, ports, job, queue, () => work).then((result) =>
    mapCreationReceipt(state, ports, job, result),
  )
  const completion = Promise.all([
    receiptPath,
    work.then(
      () => {},
      () => {},
    ),
  ]).then(() => {})
  return { completion, detached: false }
}
