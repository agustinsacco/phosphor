import type { LaneOp } from '@phosphor/shared/host-protocol'
import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import type { CommandResult } from './connection'

export const REMOTE_UNAVAILABLE = 'Not available on remote lanes yet.'
export const UNKNOWN_OUTCOME = 'The Host could not confirm this. Check the lane before retrying.'

/** The entire remote pi allowlist. Never forward arbitrary RPC to a Host. */
export function laneOperation(command: RpcCommand): LaneOp | string | null {
  switch (command.type) {
    case 'prompt':
    case 'steer':
    case 'follow_up':
    case 'abort':
    case 'abort_retry':
    case 'set_model':
    case 'set_thinking_level':
    case 'compact':
    case 'set_session_name': {
      const { id: _id, ...op } = command
      return op
    }
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
          : `${machine}: ${result.code}`,
      }
    case 'failed':
      return { ...base, success: false, error: result.error.message }
    case 'not-sent':
      return { ...base, success: false, error: `Command not sent: ${result.reason}.` }
    default:
      return { ...base, success: false, error: UNKNOWN_OUTCOME }
  }
}
