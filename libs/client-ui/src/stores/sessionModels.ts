import type { Model } from '@shared/rpc'
import { piCallInline } from '@/lib/rpc'

/**
 * One read of a live lane's model list: its bootstrap and Retry models both use it. Null when
 * pi refused or the call failed; the caller decides whether the lane is still open to hear it.
 */
export async function readSessionModels(sessionId: string): Promise<Model[] | null> {
  const result = await piCallInline(sessionId, { type: 'get_available_models' })
  return result.ok && result.data ? result.data.models : null
}
