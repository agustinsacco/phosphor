import type { AgentMessage, RpcCommand, RpcResponseDataMap } from '@shared/rpc'
import { useChatStore } from '@/stores/chat'

/**
 * Helpers over `window.phosphor.piCommand`.
 *
 * The raw API returns a `{ success, data?, error? }` envelope, which meant every
 * call site re-implemented the unwrapping — and roughly half of them dropped the
 * error branch entirely, so a failed RPC looked like a no-op in the UI. These
 * wrappers make reporting the default and silence an explicit choice.
 */

/**
 * Send a command and return its data, or `undefined` on failure after surfacing
 * the error on the session's chat surface.
 */
export async function piCall<T extends RpcCommand['type']>(
  sessionId: string,
  command: Extract<RpcCommand, { type: T }>,
): Promise<RpcResponseDataMap[T] | undefined> {
  const response = await window.phosphor.piCommand<T>(sessionId, command)
  if (!response.success) {
    useChatStore.getState().setError(sessionId, response.error ?? `${command.type} failed`)
    return undefined
  }
  return response.data
}

/**
 * Send a command and report failures, ignoring the response data. For
 * fire-and-forget settings toggles where only the failure matters.
 *
 * Returns whether the command succeeded, so callers can gate optimistic local
 * state on the result.
 */
export async function piCallOk<T extends RpcCommand['type']>(
  sessionId: string,
  command: Extract<RpcCommand, { type: T }>,
): Promise<boolean> {
  const response = await window.phosphor.piCommand<T>(sessionId, command)
  if (!response.success) {
    useChatStore.getState().setError(sessionId, response.error ?? `${command.type} failed`)
    return false
  }
  return true
}

/**
 * Re-read the transcript from pi and replace the rendered items.
 *
 * Anything that moves the session's branch point — rewind, the fork picker,
 * resuming from disk — has to follow up with this, and the three call sites had
 * drifted into three different error postures (two silent, one partial).
 *
 * Returns the messages so a caller can replay them for its own purposes
 * (artifacts rebuild theirs from persisted toolResults), or `undefined` when
 * the read failed — `piCall` has already reported that on the chat surface.
 */
export async function rehydrateTranscript(sessionId: string): Promise<AgentMessage[] | undefined> {
  const data = await piCall(sessionId, { type: 'get_messages' })
  if (!data) return undefined
  useChatStore.getState().hydrate(sessionId, data.messages)
  return data.messages
}
