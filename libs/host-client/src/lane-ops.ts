import { isLanePiOp, type LaneOp } from '@phosphor/shared/host-protocol'
import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import { BASH_UNCONFIRMED } from '@phosphor/shared/remote-host'
import { isLanePrsPrompt } from '@phosphor/shared/lane-prs-command'
import { LANE_ACTION_FAILED, UNKNOWN_OUTCOME } from '@phosphor/shared/errors'
import type { CommandResult } from './connection'

export const REMOTE_UNAVAILABLE = 'Not available on remote lanes yet.'
const LANE_STOPPED = 'this lane is stopped. Press Resume at the top of the lane, then send again.'
export { UNKNOWN_OUTCOME }
const CREATE_UNCONFIRMED = 'Lane creation not confirmed.'

/** A receipt that settled without success. The message is what callers always showed. */
class ReceiptFailure extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
  ) {
    super(message)
  }
}

/** Only a definitive fresh-branch rejection authorizes a new create request. */
class FreshBranchExists extends Error {}

/** The receipt when it succeeded; otherwise thrown, as `createFailureText` reads it. */
export function settledReceipt(op: LaneOp, result: CommandResult, machine: string): CommandResult {
  if (
    op.type === 'lane.create' &&
    op.worktree?.fresh &&
    result.status === 'rejected' &&
    result.code === 'branch-exists'
  )
    throw new FreshBranchExists('branch-exists')
  if (
    (op.type === 'lane.resume' || op.type === 'lane.stop') &&
    (result.status === 'failed' || result.status === 'rejected' || result.status === 'not-sent')
  )
    throw new ReceiptFailure(LANE_ACTION_FAILED, result)
  const response = receiptResponse(op.type, result, machine)
  if (!response.success) throw new ReceiptFailure(response.error, result)
  return result
}

/**
 * The fixed IPC text for a lane.create that did not succeed; Host details never cross
 * IPC. A refusal, a failure or an unsent frame created nothing. Anything else, an
 * unknown receipt or a dropped connection, may have.
 */
export function createFailureText(error: unknown): string {
  if (error instanceof FreshBranchExists) return 'branch-exists'
  if (!(error instanceof ReceiptFailure)) return CREATE_UNCONFIRMED
  const { result } = error
  if (result.status === 'rejected')
    return result.code === 'too-many-requests' ? 'lane-limit' : 'lane-create-failed'
  return result.status === 'failed' || result.status === 'not-sent'
    ? 'lane-create-failed'
    : CREATE_UNCONFIRMED
}

/**
 * The entire remote pi allowlist: LANE_PI_OPS as commands, and the reads as
 * lane queries. Never forward arbitrary RPC to a Host.
 */
export function laneOperation(command: RpcCommand): LaneOp | string | null {
  if (isLanePiOp(command)) {
    const { id: _id, ...op } = command
    return op
  }
  switch (command.type) {
    case 'get_state':
      return 'lane.state'
    case 'get_messages':
      return 'lane.messages'
    case 'get_session_stats':
      return 'lane.stats'
    case 'get_available_models':
      return 'lane.models'
    case 'get_commands':
      return 'lane.commands'
    default:
      return null
  }
}

type Host = { send(op: LaneOp, laneId?: string, fence?: number): Promise<CommandResult> }

/**
 * Sending a prompt is the intent to run the lane, so a stopped lane resumes once
 * first. A Host restart (an update, a crash) stops every lane and nothing starts
 * pi again; without this every message came back `lane-stopped`. Only `prompt`:
 * steer and follow-up target a running turn, and nothing else needs pi to start.
 * Track and Hide's prompt only writes lane metadata, so its refusal comes back as is.
 */
export async function sendToLane(
  host: Host,
  op: LaneOp,
  laneId: string,
  fence?: number,
): Promise<CommandResult> {
  const result = await host.send(op, laneId, fence)
  if (
    op.type !== 'prompt' ||
    isLanePrsPrompt(op.message) ||
    result.status !== 'rejected' ||
    result.code !== 'lane-stopped'
  )
    return result
  const resumed = await host.send({ type: 'lane.resume' }, laneId, fence)
  if (resumed.status !== 'done') return resumed
  return host.send(op, laneId, resumed.fence ?? fence)
}

export function receiptResponse(
  command: string,
  result: CommandResult,
  machine: string,
): RpcResponse {
  const base = { type: 'response' as const, command }
  switch (result.status) {
    case 'done':
      return { ...base, success: true, data: result.data }
    case 'rejected':
      return {
        ...base,
        success: false,
        error: result.control?.controller
          ? `${machine}: controlled by ${result.control.controller.label}`
          : result.code === 'lane-stopped'
            ? `${machine}: ${LANE_STOPPED}`
            : result.code === 'unsupported'
              ? `${machine}: its Host does not support this. Updating the Host may help.`
              : `${machine}: ${result.code}`,
      }
    case 'failed':
      return { ...base, success: false, error: result.error.message }
    case 'not-sent':
      return { ...base, success: false, error: `Command not sent: ${result.reason}.` }
    default:
      return {
        ...base,
        success: false,
        error: command === 'bash' ? `${machine}: ${BASH_UNCONFIRMED}` : UNKNOWN_OUTCOME,
      }
  }
}

export type LaneAction =
  | 'control.take'
  | 'control.release'
  | 'lane.markRead'
  | 'lane.stop'
  | 'lane.resume'
  | Extract<LaneOp, { type: 'control.take' }>
export function laneActionOp(action: LaneAction, attention: number): LaneOp {
  if (typeof action === 'object') return action
  return action === 'lane.markRead' ? { type: action, upTo: attention } : { type: action }
}
