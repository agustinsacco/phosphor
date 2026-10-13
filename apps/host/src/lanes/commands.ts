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
import { opHash, type HostStore, type StoredLane } from './store'
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

/** Parsed frames and authenticated grant clients enter here, never raw pi RPC. */
export function createLaneCommands(ports: LaneCommandPorts, options: { queueLimit?: number } = {}) {
  const { store, runtime } = ports
  const limit = options.queueLimit ?? LANE_QUEUE_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > LANE_QUEUE_LIMIT)
    throw new Error('invalid lane queue limit')
  const queues = new Map<string, Job[]>()
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
      // The receipt is durable; reconnect can ask for it again.
    }
  }
  function terminal(job: Job, receipt: Terminal, recorded: boolean, reason?: string): void {
    const result = durableReceipt(receipt)
    if (recorded) store.finishRequest(job.frame.requestId, result)
    // Count pruning can immediately evict a same-millisecond finish. Never reread here.
    deliver(job.client.id, result)
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
      ms: Math.max(0, ports.now() - job.started),
      trace: job.frame.trace,
      reason,
    })
  }
  function rejected(job: Job, code: RejectCode, recorded: boolean): void {
    terminal(job, { requestId: job.frame.requestId, status: 'rejected', code }, recorded)
  }
  /** The timer wins only once. A late resolution cannot rewrite an unknown receipt. */
  function answer<T>(
    job: Job,
    run: () => Promise<T> | T,
  ): Promise<{ answered: true; value: T } | { answered: false; reason: string }> {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        resolve({ answered: false, reason: 'deadline' })
      }, HOST_LIMITS.commandAnswerMs)
      timer.unref()
      const complete = (
        value: { answered: true; value: T } | { answered: false; reason: string },
      ) => {
        if (settled) {
          log('lane.command_late', {
            laneId: job.frame.laneId,
            requestId: job.frame.requestId,
            op: job.frame.op.type,
          })
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      try {
        Promise.resolve(run()).then(
          (value) => complete({ answered: true, value }),
          () => complete({ answered: false, reason: 'transport' }),
        )
      } catch {
        complete({ answered: false, reason: 'transport' })
      }
    })
  }
  async function execute(job: Job): Promise<void> {
    const { frame, client } = job
    const { requestId, laneId, op } = frame
    if (op.type === 'lane.create') return rejected(job, 'unsupported', true)
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
      if (admission.control.fence !== lane.control.fence)
        ports.publish(laneId, { kind: 'control', control: admission.control })
    }
    if (piCommand && sessionId !== null) {
      const result = await answer(job, () => runtime.command(sessionId, piCommand))
      if (!result.answered)
        return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
      const response = result.value
      return terminal(
        job,
        response.success
          ? { requestId, status: 'done', data: response.data }
          : {
              requestId,
              status: 'failed',
              error: {
                code: 'pi-error',
                message: receiptMessage(response.error),
              },
            },
        true,
      )
    }
    switch (op.type) {
      case 'extension_ui_response': {
        if (sessionId === null) return rejected(job, 'lane-stopped', true)
        const result = await answer(job, () => runtime.extensionUiResponse(sessionId, op.response))
        if (!result.answered)
          return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
        ports.publish(laneId, { kind: 'dialog-resolved', dialogId: op.response.id })
        break
      }
      case 'control.take': {
        const control = store.takeControl(laneId, { clientId: client.id, label: client.label })
        ports.publish(laneId, { kind: 'control', control })
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
        ports.publish(laneId, { kind: 'control', control: released.control })
        return terminal(job, { requestId, status: 'done', fence: released.control.fence }, true)
      }
      case 'lane.markRead': {
        store.markRead(laneId, op.upTo)
        const summary = ports.summaryFor(laneId)
        if (summary) ports.publish(laneId, { kind: 'summary', summary })
        break
      }
      case 'lane.resume':
      case 'lane.stop': {
        const resume = op.type === 'lane.resume'
        if (resume ? sessionId !== null : sessionId === null) break
        const result = await answer(job, async () => {
          try {
            if (resume) await ports.resumeLane(lane)
            else await ports.stopLane(laneId)
            return null
          } catch (error) {
            const code =
              typeof error === 'object' && error !== null && 'code' in error
                ? error.code
                : undefined
            if (typeof code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(code))
              log('lane.command_error', { laneId, requestId, op: op.type, code })
            return {
              code: 'internal',
              message: resume ? 'the lane could not start' : 'the lane could not stop',
            } as const
          }
        })
        if (!result.answered)
          return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
        if (result.value)
          return terminal(job, { requestId, status: 'failed', error: result.value }, true)
        break
      }
      default:
        return rejected(job, 'unsupported', true)
    }
    terminal(job, { requestId, status: 'done' }, true)
  }
  async function drain(key: string, queue: Job[]): Promise<void> {
    while (queue.length) {
      const job = queue[0]
      if (!job) break
      try {
        await execute(job)
      } catch {
        // Publication or other host failures may happen after a mutation.
        terminal(job, { requestId: job.frame.requestId, status: 'unknown' }, true, 'host')
      } finally {
        queue.shift()
        job.resolve()
      }
    }
    queues.delete(key)
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
      if ((queue?.length ?? 0) >= limit && store.getReceipt(frame.requestId, client.id) === null) {
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
      const fresh = queue === undefined
      if (!queue) {
        queue = []
        queues.set(key, queue)
      }
      const completion = new Promise<void>((resolve) => queue.push({ ...jobBase, resolve }))
      if (fresh) void drain(key, queue)
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
