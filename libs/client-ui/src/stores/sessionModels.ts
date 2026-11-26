import { piCallInline } from '@/lib/rpc'
import { useChatStore } from './chat'

/** Bootstrap and Retry share a read and update the list as soon as pi answers. */
export async function loadSessionModels(sessionId: string, isOpen: () => boolean): Promise<void> {
  const chat = useChatStore.getState()
  chat.setModels(sessionId, undefined)
  const result = await piCallInline(sessionId, { type: 'get_available_models' })
  if (isOpen()) chat.setModels(sessionId, result.ok ? (result.data?.models ?? null) : null)
}
