import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import type { LiveSession } from './session-registry'

export type SessionUserInput = Extract<RpcCommand, { type: 'prompt' | 'steer' | 'follow_up' }>
export interface SessionInputReceipt {
  complete(response: RpcResponse | undefined): void | Promise<void>
}
/** Trusted process-local callbacks, never serialized in session projections. */
export interface SessionInputObserver {
  beforeInput(command: SessionUserInput): Promise<SessionInputReceipt | undefined>
  invalidate(): void
  failed(error: unknown): Promise<void>
}
const REPLACES_INPUT = new Set(['switch_session', 'new_session', 'fork', 'clone', 'clear_queue'])

export async function invalidateSessionInput(
  live: LiveSession,
  command?: RpcCommand,
): Promise<void> {
  if (command && !REPLACES_INPUT.has(command.type)) return
  const observer = live.memoryInput
  delete live.memoryInput
  try {
    observer?.invalidate()
  } catch (error) {
    await observer?.failed(error)
  }
}
async function failed(
  live: LiveSession,
  observer: SessionInputObserver,
  error: unknown,
): Promise<void> {
  if (live.memoryInput === observer) delete live.memoryInput
  await observer.failed(error)
}
/** A broken optional observer cannot prevent an ordinary RPC or replace its result. */
export async function withSessionInput<T extends RpcResponse>(
  live: LiveSession,
  command: RpcCommand,
  send: () => Promise<T>,
): Promise<T> {
  const observer = live.memoryInput
  let receipt: SessionInputReceipt | undefined
  if (observer && ['prompt', 'steer', 'follow_up'].includes(command.type)) {
    try {
      receipt = await observer.beforeInput(command as SessionUserInput)
    } catch (error) {
      await failed(live, observer, error)
    }
  }
  const complete = async (response: RpcResponse | undefined): Promise<void> => {
    if (!receipt || !observer || live.memoryInput !== observer) return
    try {
      await receipt.complete(response)
    } catch (error) {
      await failed(live, observer, error)
    }
  }
  let result: T
  try {
    result = await send()
  } catch (error) {
    await complete(undefined)
    throw error
  }
  await complete(result)
  return result
}
