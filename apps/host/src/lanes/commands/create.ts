import { normalizeLabel } from '@phosphor/shared/control-api'
import { HOST_LIMITS, type LaneCreatePhase, type LaneOp } from '@phosphor/shared/host-protocol'
import { createLane } from '../create'
import { LaneCapacityReached, type HostStore, type StoredLane } from '../store'
import { LaneFolderError } from '../worktree'
import { sendFirstPrompt, type FirstPromptPorts } from './create-prompt'
import { dispatch, drain, publish, queueFor } from './queue'
import { deliver, log, rejected, terminal, type ReceiptPorts } from './receipts'
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
  FirstPromptPorts &
  Pick<LaneCommandPorts, 'store' | 'sessions' | 'publish' | 'summaryFor'>
/** What the creation work settled to. The receipt path maps it once it is answered. */
export type CreationResult =
  /** `prompted` is the first prompt's outcome; see sendFirstPrompt. */
  | { kind: 'created'; lane: StoredLane; prompted?: boolean }
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
  /** The receipt (or the deadline's unknown) is out: no phase follows it. */
  answered?: boolean
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

/**
 * Classify a createLane failure. The log gets a token-shaped error code, or a folder
 * error's sentence, which the Host fixes itself; never free text from pi or git.
 */
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
  else if (error instanceof LaneFolderError)
    log(ports, 'lane.command_error', { requestId, op: 'lane.create', reason: error.message })
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

/**
 * Unrecorded pending receipts with the creation's phase, to the creating connection
 * only. They stop at the terminal receipt and at close; delivery swallows failures.
 */
export function phaseReporter(
  state: CommandState,
  ports: Pick<LaneCommandPorts, 'deliver'>,
  job: Job,
  creation: Creation,
): (phase: LaneCreatePhase) => void {
  const { client, frame } = job
  return (phase) => {
    if (creation.answered || state.closing || state.closed || client.connectionId === undefined)
      return
    deliver(
      ports,
      client.id,
      { requestId: frame.requestId, status: 'pending', phase },
      client.connectionId,
    )
  }
}

export async function runCreation(
  state: CommandState,
  ports: CreatePorts,
  job: Job,
  input: { op: CreateOp; root: string; creation: Creation; execute: ExecuteJob },
): Promise<CreationResult> {
  const { client, frame } = job
  const { op, root, creation } = input
  const phase = phaseReporter(state, ports, job, creation)
  try {
    let lane: StoredLane
    try {
      lane = await createLane(
        { ...ports, folders: state.folders, closed: () => state.closed },
        {
          root,
          op,
          controller: { clientId: client.id, label: client.label },
          onStored: (laneId) => holdCreatedLane(state, creation, laneId),
          phase,
        },
      )
    } catch (error) {
      return creationFailure(ports, frame.requestId, error)
    }
    if (state.closed) return { kind: 'closed' }
    if (!creation.hold) throw new Error('missing lane queue')
    publishCreated(state, ports, lane, creation.hold.queue)
    if (op.prompt === undefined) return { kind: 'created', lane }
    // Still under the hold, so the prompt reaches pi before any queued lane op.
    phase('prompting')
    const target = { laneId: lane.laneId, requestId: frame.requestId }
    return { kind: 'created', lane, prompted: await sendFirstPrompt(ports, target, op.prompt) }
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
        {
          requestId,
          status: 'done',
          laneId: outcome.lane.laneId,
          fence: 1,
          ...(outcome.prompted === undefined ? {} : { data: { prompted: outcome.prompted } }),
        },
        true,
      )
    case 'closed':
      // Closed answers nothing; the queue's unknown for this throw is dropped too.
      throw new Error('missing lane')
  }
}

/**
 * lane.create, detached from the machine queue: the next laneless op starts at
 * dispatch, and only worktree work waits, per repository (state.folders). The
 * completion still waits for both the receipt and the work, and the dispatched
 * work counts against the queue's slots until its rollback settles.
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
  const receiptPath = dispatch(state, ports, job, queue, () => work).then((result) => {
    creation.answered = true
    mapCreationReceipt(state, ports, job, result)
  })
  const completion = Promise.all([
    receiptPath,
    work.then(
      () => {},
      () => {},
    ),
  ]).then(() => {})
  return { completion, detached: true }
}
