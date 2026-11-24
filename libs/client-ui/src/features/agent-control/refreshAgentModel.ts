import { piCall } from '@/lib/rpc'
import { useChatStore } from '@/stores/chat'
import { refreshThinkingLevels, useSessionsStore } from '@/stores/sessions'

const pending = new Map<string, { again: boolean }>()

/** Signals are invalidations, not model values. Serialize reads and recheck if
 * a newer change arrived mid-flight. Never patch a replaced lane or user pick. */
export async function refreshAgentModel(id: string): Promise<void> {
  const prior = pending.get(id)
  if (prior) {
    prior.again = true
    return
  }
  const flight = { again: false }
  pending.set(id, flight)
  try {
    do {
      flight.again = false
      const live = useSessionsStore.getState().live[id]
      const before = useChatStore.getState().sessions[id]?.meta
      if (!before || !live) return
      const state = await piCall(id, { type: 'get_state' })
      const chat = useChatStore.getState()
      const current = chat.sessions[id]?.meta
      if (
        !state ||
        flight.again ||
        live !== useSessionsStore.getState().live[id] ||
        current?.sessionId !== state.sessionId ||
        current?.model !== before.model ||
        current?.thinkingLevel !== before.thinkingLevel
      )
        continue
      const changedModel =
        state.model?.provider !== before.model?.provider || state.model?.id !== before.model?.id
      chat.patchMeta(id, { model: state.model, thinkingLevel: state.thinkingLevel })
      if (changedModel) {
        chat.setThinkingLevels(id, null)
        await refreshThinkingLevels(id)
      }
    } while (flight.again)
  } finally {
    pending.delete(id)
  }
}
