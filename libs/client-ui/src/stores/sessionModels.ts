import type { Model } from '@shared/rpc'
import { piCallInline } from '@/lib/rpc'
import { useChatStore } from './chat'

/**
 * One read of a live lane's model list: its bootstrap and Retry models both use it. Null when
 * pi refused or the call failed; the caller decides whether the lane is still open to hear it.
 */
export async function readSessionModels(sessionId: string): Promise<Model[] | null> {
  const result = await piCallInline(sessionId, { type: 'get_available_models' })
  return result.ok && result.data ? result.data.models : null
}

/** Record a model read on the lane's chat. A failed read leaves what the chat had. */
export function applySessionModels(sessionId: string, models: Model[] | null): void {
  if (models) useChatStore.getState().setModels(sessionId, models)
}
