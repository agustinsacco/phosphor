import {
  HOST_LIMITS,
  UNFENCED_OPS,
  type ClientFrame,
  type LaneEvent,
  type LaneSummary,
  type Receipt,
  type RejectCode,
} from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { RpcCommand } from '@phosphor/shared/rpc'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { commandRefusal, type HostRuntime } from '../session/runtime'
import { normalizeLabel } from '@phosphor/shared/control-api'
import { LaneCapacityReached, opHash, type HostStore, type StoredLane } from './store'
import { createLane, type LaneSessions } from './create'
import { LaneFolderError } from './worktree'
import { canonicalJson, JsonTooLarge } from './validation'

export const LANE_QUEUE_LIMIT = 32
export type LaneCommandFrame = Extract<ClientFrame, { type: 'command' }>
export interface LaneCommandClient {
  id: string
  label: string
  caps: readonly HostCapability[]
}
export interface LaneCommandPorts {
  store: HostStore
  sessions: LaneSessions
  runtime: Pick<HostRuntime, 'command' | 'extensionUiResponse'>
  /** Wiring owns projection delivery and the live-session mapping. */
  resumeLane(lane: StoredLane): Promise<void>
  stopLane(laneId: string): Promise<void>
  sessionFor(laneId: string): string | null
  openDialogs(laneId: string): readonly string[]
  /** Read after the store write: persisted control, counters and timestamps from
   * the store; live activity, title and model from the projection. */
  summaryFor(laneId: string): LaneSummary | null
  publish(laneId: string, event: LaneEvent): void
  /** The adapter fans out to interested connections of this client only. */
  deliver(clientId: string, receipt: Receipt): void
  now(): number
  log: RuntimeLog
  refusal?: (command: RpcCommand) => string | null
}
type Terminal = Exclude<Receipt, { status: 'pending' }>
type Job = {
  client: LaneCommandClient
  frame: LaneCommandFrame
  started: number
  resolve(): void
}

type LaneQueue = {
  jobs: Job[]
  outstanding: number
  draining: boolean
  controlUnpublished: boolean
}
type Answer<T> = { answered: true; value: T } | { answered: false; reason: string }
type Execution = { completion: Promise<void>; detached: boolean }
type OperationIdentity = { laneId: string; requestId: string; opType: string }

/** Parsed frames and authenticated grant clients enter here, never raw pi RPC. */
export function createLaneCommands(ports: LaneCommandPorts, options: { queueLimit?: number } = {}) {
  const { store, runtime } = ports
  const limit = options.queueLimit ?? LANE_QUEUE_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > LANE_QUEUE_LIMIT)
    throw new Error('invalid lane queue limit')
  const queues = new Map<string, LaneQueue>()
  const refusal = ports.refusal ?? commandRefusal
  // Delivery and logging must not strand the next recorded request.
  function log(message: string, data: unknown): void {
    try {
      ports.log('host', message, data)
    } catch {
      // Logging is not in the command ordering path.
    }
  }
  function deliver(clientId: string, receipt: Receipt): void {
    try {
      ports.deliver(clientId, receipt)
    } catch {
      // A reconnect can ask the store for the request's status.
    }
  }
  function elapsed(started: number): number | undefined {
    try {
      return Math.max(0, ports.now() - started)
    } catch {
      return undefined
    }
  }
  function terminal(job: Job, receipt: Terminal, recorded: boolean, reason?: string): void {
    let result: Terminal = { requestId: job.frame.requestId, status: 'unknown' }
    try {
      result = durableReceipt(receipt)
    } catch {
      // Invalid runtime data cannot become a receipt.
    }
    if (recorded) {
      try {
        store.finishRequest(job.frame.requestId, result)
      } catch {
        log('lane.receipt_unrecorded', {
          laneId: job.frame.laneId,
          requestId: job.frame.requestId,
        })
      }
    }
    // Count pruning can immediately evict a same-millisecond finish. Never reread here.
    deliver(job.client.id, result)
    receipt = result
    log('lane.command', {
      laneId: job.frame.laneId,
      requestId: job.frame.requestId,
      op: job.frame.op.type,
      status: receipt.status,
      code:
        receipt.status === 'rejected'
          ? receipt.code
          : receipt.status === 'failed'
            ? receipt.error.code
            : undefined,
      fence:
        receipt.status === 'done'
          ? receipt.fence
          : receipt.status === 'rejected'
            ? receipt.control?.fence
            : undefined,
      ms: elapsed(job.started),
      trace: job.frame.trace,
      reason,
    })
  }
  function rejected(job: Job, code: RejectCode, recorded: boolean): void {
    terminal(job, { requestId: job.frame.requestId, status: 'rejected', code }, recorded)
  }
  function cleanup(key: string, queue: LaneQueue): void {
    if (!queue.draining && !queue.jobs.length && !queue.outstanding && !queue.controlUnpublished)
      queues.delete(key)
  }
  function publish(laneId: string, event: LaneEvent, queue: LaneQueue): boolean {
    try {
      ports.publish(laneId, event)
      if (event.kind === 'control') queue.controlUnpublished = false
      return true
    } catch {
      if (event.kind === 'control') queue.controlUnpublished = true
      log('lane.publish_failed', { laneId, kind: event.kind })
      return false
    }
  }
  function controlFailure(job: Job): void {
    terminal(
      job,
      {
        requestId: job.frame.requestId,
        status: 'failed',
        error: { code: 'internal', message: "the lane's control change could not be published" },
      },
      true,
    )
  }
  /** After a deadline, only the operation identity and slot survive, not the job or payload. */
  function answer<T>(
    identity: OperationIdentity,
    queue: LaneQueue,
    promise: Promise<T>,
  ): Promise<Answer<T>> {
    queue.outstanding++
    return new Promise((resolve) => {
      let reply: ((answer: Answer<T>) => void) | undefined = resolve
      const timer = setTimeout(() => {
        reply?.({ answered: false, reason: 'deadline' })
        reply = undefined
      }, HOST_LIMITS.commandAnswerMs)
      timer.unref()
      const complete = (value: Answer<T>) => {
        queue.outstanding--
        clearTimeout(timer)
        if (reply) {
          reply(value)
          reply = undefined
        } else {
          log('lane.command_late', {
            laneId: identity.laneId,
            requestId: identity.requestId,
            op: identity.opType,
          })
        }
        cleanup(identity.laneId, queue)
      }
      promise
        .then(
          (value) => complete({ answered: true, value }),
          () => complete({ answered: false, reason: 'transport' }),
        )
        .catch(() => {})
    })
  }
  // Invoke outside answer's settle closures so an unresolved runtime cannot retain run or job.
  function dispatch<T>(job: Job, queue: LaneQueue, run: () => Promise<T> | T): Promise<Answer<T>> {
    let promise: Promise<T>
    try {
      promise = Promise.resolve(run())
    } catch {
      promise = Promise.reject(new Error('transport'))
    }
    return answer(
      { laneId: job.frame.laneId ?? '', requestId: job.frame.requestId, opType: job.frame.op.type },
      queue,
      promise,
    )
  }
  function execute(job: Job, queue: LaneQueue): Execution | void {
    const { frame, client } = job
    const { requestId, laneId, op } = frame
    if (queue.controlUnpublished && laneId !== undefined) {
      const control = store.getLane(laneId)?.control
      if (!control) {
        queue.controlUnpublished = false
        return rejected(job, 'unknown-lane', true)
      }
      if (!publish(laneId, { kind: 'control', control }, queue)) return controlFailure(job)
    }
    if (op.type === 'lane.create') {
      const repository = store.listRepositories().find((entry) => entry.id === op.repositoryId)
      if (
        laneId !== undefined ||
        !repository ||
        (op.provider !== undefined && op.provider.length > 64) ||
        (op.model !== undefined && op.model.length > 128) ||
        (op.name !== undefined &&
          (op.name.length > HOST_LIMITS.labelChars || normalizeLabel(op.name) !== op.name))
      )
        return rejected(job, 'bad-request', true)
      if (store.listLanes().length >= store.limits.lanesPerHost)
        return rejected(job, 'too-many-requests', true)
      const completion = dispatch(job, queue, async () => {
        try {
          return {
            lane: await createLane(ports, {
              root: repository.path,
              op,
              controller: { clientId: client.id, label: client.label },
            }),
          }
        } catch (error) {
          if (error instanceof LaneCapacityReached) return { capacity: true }
          const code =
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
          if (typeof code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(code))
            log('lane.command_error', { requestId, op: op.type, code })
          return {
            error: {
              code: 'internal' as const,
              message:
                error instanceof LaneFolderError ? error.message : 'the lane could not start',
            },
          }
        }
      }).then((result) => {
        if (!result.answered)
          return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
        if (result.value.capacity) return rejected(job, 'too-many-requests', true)
        if (result.value.error)
          return terminal(job, { requestId, status: 'failed', error: result.value.error }, true)
        const created = result.value.lane
        if (!created) throw new Error('missing lane')
        if (!publish(created.laneId, { kind: 'control', control: created.control }, queue))
          return controlFailure(job)
        const summary = ports.summaryFor(created.laneId)
        if (summary) publish(created.laneId, { kind: 'summary', summary }, queue)
        terminal(job, { requestId, status: 'done', laneId: created.laneId, fence: 1 }, true)
      })
      return { completion, detached: false }
    }
    const lane = laneId === undefined ? null : store.getLane(laneId)
    if (!lane || laneId === undefined) return rejected(job, 'unknown-lane', true)
    const sessionId = ports.sessionFor(laneId)
    const piCommand = toPiCommand(op, requestId)
    if ((piCommand || op.type === 'extension_ui_response') && sessionId === null)
      return rejected(job, 'lane-stopped', true)
    if (piCommand && refusal(piCommand) !== null) return rejected(job, 'unsupported', true)
    if (op.type === 'extension_ui_response' && !ports.openDialogs(laneId).includes(op.response.id))
      return rejected(job, 'bad-request', true)
    // Release never acquires an empty lane just to release it again.
    if (op.type === 'control.release' && lane.control.controller === null)
      return terminal(
        job,
        { requestId, status: 'rejected', code: 'not-controller', control: lane.control },
        true,
      )
    if (!UNFENCED_OPS.includes(op.type)) {
      if (frame.fence === undefined) return rejected(job, 'bad-request', true)
      const admission = store.admit(
        laneId,
        { clientId: client.id, label: client.label },
        frame.fence,
      )
      if (!admission.admitted) {
        return terminal(
          job,
          { requestId, status: 'rejected', code: admission.code, control: admission.control },
          true,
        )
      }
      if (
        admission.control.fence !== lane.control.fence &&
        !publish(laneId, { kind: 'control', control: admission.control }, queue)
      )
        return controlFailure(job)
    }
    if (piCommand && sessionId !== null) {
      const completion = dispatch(job, queue, () => runtime.command(sessionId, piCommand)).then(
        (result) => {
          if (!result.answered)
            return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
          const response = result.value
          terminal(
            job,
            response.success
              ? { requestId, status: 'done', data: response.data }
              : {
                  requestId,
                  status: 'failed',
                  error: { code: 'pi-error', message: receiptMessage(response.error) },
                },
            true,
          )
        },
      )
      return { completion, detached: true }
    }
    switch (op.type) {
      case 'extension_ui_response': {
        if (sessionId === null) return rejected(job, 'lane-stopped', true)
        const completion = dispatch(job, queue, () =>
          runtime.extensionUiResponse(sessionId, op.response),
        ).then((result) => {
          if (!result.answered)
            return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
          publish(laneId, { kind: 'dialog-resolved', dialogId: op.response.id }, queue)
          terminal(job, { requestId, status: 'done' }, true)
        })
        return { completion, detached: true }
      }
      case 'control.take': {
        const control = store.takeControl(laneId, { clientId: client.id, label: client.label })
        publish(laneId, { kind: 'control', control }, queue)
        return terminal(job, { requestId, status: 'done', fence: control.fence }, true)
      }
      case 'control.release': {
        const released = store.releaseControl(laneId, client.id)
        if (!released.released)
          return terminal(
            job,
            { requestId, status: 'rejected', code: 'not-controller', control: released.control },
            true,
          )
        publish(laneId, { kind: 'control', control: released.control }, queue)
        return terminal(job, { requestId, status: 'done', fence: released.control.fence }, true)
      }
      case 'lane.markRead': {
        store.markRead(laneId, op.upTo)
        const summary = ports.summaryFor(laneId)
        if (summary) publish(laneId, { kind: 'summary', summary }, queue)
        break
      }
      case 'lane.resume':
      case 'lane.stop': {
        const resume = op.type === 'lane.resume'
        if (resume ? sessionId !== null : sessionId === null) break
        const completion = dispatch(job, queue, () =>
          lifecycle(laneId, requestId, op.type, lane),
        ).then((result) => {
          if (!result.answered)
            return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
          terminal(
            job,
            result.value
              ? { requestId, status: 'failed', error: result.value }
              : { requestId, status: 'done' },
            true,
          )
        })
        return { completion, detached: false }
      }
      default:
        return rejected(job, 'unsupported', true)
    }
    terminal(job, { requestId, status: 'done' }, true)
  }
  async function lifecycle(
    laneId: string,
    requestId: string,
    opType: 'lane.resume' | 'lane.stop',
    lane: StoredLane,
  ) {
    const resume = opType === 'lane.resume'
    try {
      if (resume) await ports.resumeLane(lane)
      else await ports.stopLane(laneId)
      return null
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (typeof code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(code))
        log('lane.command_error', { laneId, requestId, op: opType, code })
      return {
        code: 'internal',
        message: resume ? 'the lane could not start' : 'the lane could not stop',
      } as const
    }
  }
  async function drain(key: string, queue: LaneQueue): Promise<void> {
    queue.draining = true
    while (queue.jobs.length) {
      const job = queue.jobs[0]
      if (!job) break
      let execution: Execution | void = undefined
      try {
        execution = execute(job, queue)
      } catch {
        terminal(job, { requestId: job.frame.requestId, status: 'unknown' }, true, 'host')
      } finally {
        queue.jobs.shift()
        if (!execution) job.resolve()
      }
      if (execution) {
        const completion = execution.completion
          .catch(() => {
            terminal(job, { requestId: job.frame.requestId, status: 'unknown' }, true, 'host')
          })
          .finally(job.resolve)
          .catch(() => {})
        if (!execution.detached) await completion
      }
    }
    queue.draining = false
    cleanup(key, queue)
  }
  return {
    submit(client: LaneCommandClient, frame: LaneCommandFrame): Promise<void> {
      const jobBase = { client, frame, started: ports.now() }
      const immediate = { ...jobBase, resolve: () => {} }
      if (!client.caps.includes('sessions.control')) {
        rejected(immediate, 'forbidden', false)
        return Promise.resolve()
      }
      const key = frame.laneId ?? ''
      let queue = queues.get(key)
      if (
        (queue?.jobs.length ?? 0) + (queue?.outstanding ?? 0) >= limit &&
        store.getReceipt(frame.requestId, client.id) === null
      ) {
        rejected(immediate, 'busy', false)
        return Promise.resolve()
      }
      const begin = store.beginRequest(
        frame.requestId,
        client.id,
        opHash(frame.op),
        frame.laneId ?? null,
      )
      if (begin.kind === 'existing') {
        deliver(client.id, begin.receipt)
        return Promise.resolve()
      }
      if (begin.kind !== 'new') {
        rejected(immediate, begin.kind, false)
        return Promise.resolve()
      }
      if (!queue) {
        queue = { jobs: [], outstanding: 0, draining: false, controlUnpublished: false }
        queues.set(key, queue)
      }
      const completion = new Promise<void>((resolve) => queue.jobs.push({ ...jobBase, resolve }))
      if (!queue.draining) void drain(key, queue).catch(() => {})
      return completion
    },
    status(clientId: string, requestId: string): void {
      deliver(clientId, store.getReceipt(requestId, clientId) ?? { requestId, status: 'unknown' })
    },
  }
}

function durableReceipt(receipt: Terminal): Terminal {
  if (receipt.status !== 'done' || receipt.data === undefined) return receipt
  try {
    canonicalJson(receipt.data, HOST_LIMITS.receiptDataBytes)
    return receipt
  } catch (error) {
    if (!(error instanceof JsonTooLarge)) throw error
    const { data: _data, ...withoutData } = receipt
    return withoutData
  }
}

/** Match the store's text predicate and the wire's non-empty message rule. */
export function receiptMessage(raw: unknown): string {
  const fallback = 'pi reported an error'
  if (typeof raw !== 'string') return fallback
  let normalized = ''
  for (const char of raw) {
    const code = char.charCodeAt(0)
    normalized += code < 32 || code === 127 || code === 0x2028 || code === 0x2029 ? ' ' : char
  }
  let message = ''
  for (const char of normalized.trim()) {
    if (message.length + char.length > HOST_LIMITS.messageChars) break
    message += char
  }
  return message || fallback
}

function toPiCommand(op: LaneCommandFrame['op'], id: string): RpcCommand | null {
  switch (op.type) {
    case 'prompt':
    case 'steer':
    case 'follow_up':
    case 'abort':
    case 'abort_retry':
    case 'set_model':
    case 'set_thinking_level':
    case 'compact':
    case 'set_session_name':
      return { ...op, id }
    default:
      return null
  }
}
