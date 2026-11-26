import { piCallInline } from '@/lib/rpc'
import { useChatStore } from './chat'

const inFlight = new Map<string, Promise<void>>()

/** Bootstrap and Retry share a read and update the list as soon as pi answers. */
export async function loadSessionModels(sessionId: string, isOpen: () => boolean): Promise<void> {
  const chat = useChatStore.getState()
  const session = chat.sessions[sessionId]
  if (!isOpen() || !session) return
  // A lane re-adopted under the same id has a fresh chat slice and no read in progress.
  const pending = inFlight.get(sessionId)
  if (pending && session.modelsRefreshing) return pending

  const current = () =>
    isOpen() &&
    inFlight.get(sessionId) === run &&
    useChatStore.getState().sessions[sessionId]?.modelsRefreshing
  const run = Promise.resolve()
    .then(async () => {
      if (!current()) return
      const result = await piCallInline(sessionId, { type: 'get_available_models' })
      if (current()) chat.setModels(sessionId, result.ok ? (result.data?.models ?? null) : null)
    })
    .finally(() => {
      if (inFlight.get(sessionId) === run) inFlight.delete(sessionId)
    })
  // Register before notifying chat subscribers, so even a synchronous retry joins this read.
  inFlight.set(sessionId, run)
  chat.setModels(sessionId, undefined)
  return run
}
