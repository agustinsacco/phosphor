import { HOST_LIMITS, type Receipt, type RejectCode } from '@phosphor/shared/host-protocol'
import { canonicalJson, JsonTooLarge } from '../validation'
import type { HostStore } from '../store'
import type { CommandState, Job, LaneCommandPorts, Terminal } from './state'

export type ReceiptPorts = Pick<LaneCommandPorts, 'deliver' | 'log' | 'now'> & {
  store: Pick<HostStore, 'finishRequest'>
}

// Delivery and logging must not strand the next recorded request.
export function log(ports: Pick<LaneCommandPorts, 'log'>, message: string, data: unknown): void {
  try {
    ports.log('host', message, data)
  } catch {
    // Logging is not in the command ordering path.
  }
}

export function deliver(
  ports: Pick<LaneCommandPorts, 'deliver'>,
  clientId: string,
  receipt: Receipt,
  connectionId?: string,
): void {
  try {
    ports.deliver(clientId, receipt, connectionId)
  } catch {
    // A reconnect can ask the store for the request's status.
  }
}

function elapsed(ports: Pick<LaneCommandPorts, 'now'>, started: number): number | undefined {
  try {
    return Math.max(0, ports.now() - started)
  } catch {
    return undefined
  }
}

/** Record (unless an unrecorded refusal), deliver and log a job's one terminal receipt. */
export function terminal(
  state: Pick<CommandState, 'closed'>,
  ports: ReceiptPorts,
  job: Job,
  receipt: Terminal,
  recorded: boolean,
  reason?: string,
): void {
  if (state.closed) return
  let result: Terminal = { requestId: job.frame.requestId, status: 'unknown' }
  try {
    result = durableReceipt(receipt)
  } catch {
    // Invalid runtime data cannot become a receipt.
  }
  if (recorded) {
    try {
      ports.store.finishRequest(job.frame.requestId, result)
    } catch {
      log(ports, 'lane.receipt_unrecorded', {
        laneId: job.frame.laneId,
        requestId: job.frame.requestId,
      })
    }
  }
  // Count pruning can immediately evict a same-millisecond finish. Never reread here.
  deliver(ports, job.client.id, result, recorded ? undefined : job.client.connectionId)
  receipt = result
  log(ports, 'lane.command', {
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
    ms: elapsed(ports, job.started),
    trace: job.frame.trace,
    reason,
  })
}

export function rejected(
  state: Pick<CommandState, 'closed'>,
  ports: ReceiptPorts,
  job: Job,
  code: RejectCode,
  recorded: boolean,
): void {
  terminal(
    state,
    ports,
    job,
    { requestId: job.frame.requestId, status: 'rejected', code },
    recorded,
  )
}

export function controlFailure(
  state: Pick<CommandState, 'closed'>,
  ports: ReceiptPorts,
  job: Job,
): void {
  terminal(
    state,
    ports,
    job,
    {
      requestId: job.frame.requestId,
      status: 'failed',
      error: { code: 'internal', message: "the lane's control change could not be published" },
    },
    true,
  )
}

export function durableReceipt(receipt: Terminal): Terminal {
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
