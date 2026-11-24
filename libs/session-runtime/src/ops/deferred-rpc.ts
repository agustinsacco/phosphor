/**
 * The pi RPC command each deferred lane change becomes, for owners that apply
 * them by sending pi a command. Reload, stop and archive are owner actions,
 * not one command, so they have none here. Living contract: docs/agent-control.md.
 */
import type { RpcCommand, ThinkingLevel } from '@phosphor/shared/rpc'
import type { LaneDeferred } from './types'

/** Null for a deferred item that is not a single pi command. */
export function deferredRpcCommand(item: LaneDeferred): RpcCommand | null {
  switch (item.kind) {
    case 'model':
      return { type: 'set_model', provider: item.provider, modelId: item.modelId }
    case 'thinking':
      return { type: 'set_thinking_level', level: item.level as ThinkingLevel }
    case 'compact':
      return { type: 'compact', customInstructions: item.instructions }
    case 'autoRetry':
      return { type: 'set_auto_retry', enabled: item.enabled }
    case 'autoCompaction':
      return { type: 'set_auto_compaction', enabled: item.enabled }
    case 'steering':
      return { type: 'set_steering_mode', mode: item.mode }
    case 'follow-up':
      return { type: 'set_follow_up_mode', mode: item.mode }
    default:
      return null
  }
}
