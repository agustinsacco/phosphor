import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { AgentMessage, RpcSessionState } from '@phosphor/shared/rpc'
import { ALL_THINKING_LEVELS } from '@phosphor/shared/thinking'

export const PI_MESSAGES_MAX = HOST_LIMITS.pendingEvents * 25
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const message = (value: unknown): value is AgentMessage =>
  record(value) && typeof value.role === 'string'

/** pi is a trusted local child. Keep payload checks shallow, as on the wire. */
export function piMessages(data: unknown): AgentMessage[] | null {
  return Array.isArray(data) && data.length <= PI_MESSAGES_MAX && data.every(message) ? data : null
}
function state(value: unknown): value is RpcSessionState {
  return (
    record(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.isStreaming === 'boolean' &&
    typeof value.isCompacting === 'boolean' &&
    typeof value.thinkingLevel === 'string' &&
    ALL_THINKING_LEVELS.some((level) => level === value.thinkingLevel) &&
    (value.steeringMode === 'all' || value.steeringMode === 'one-at-a-time') &&
    (value.followUpMode === 'all' || value.followUpMode === 'one-at-a-time') &&
    typeof value.autoCompactionEnabled === 'boolean' &&
    Number.isSafeInteger(value.messageCount) &&
    typeof value.messageCount === 'number' &&
    value.messageCount >= 0 &&
    Number.isSafeInteger(value.pendingMessageCount) &&
    typeof value.pendingMessageCount === 'number' &&
    value.pendingMessageCount >= 0 &&
    (value.sessionName === undefined || typeof value.sessionName === 'string') &&
    (value.model === undefined ||
      value.model === null ||
      (record(value.model) &&
        typeof value.model.id === 'string' &&
        typeof value.model.provider === 'string'))
  )
}
export function piState(data: unknown): RpcSessionState | null {
  return state(data) ? data : null
}
