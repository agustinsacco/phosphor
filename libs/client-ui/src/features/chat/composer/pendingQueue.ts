import { create } from 'zustand'
import { useChatStore } from '@/stores/chat'

interface PendingChip {
  id: string
  sessionId: string
  kind: 'steer' | 'follow-up'
  text: string
  /** Only a dispatched prompt can be matched, and only against its actual pi text. */
  match?: { text: string; previousCount: number }
}

export const usePendingQueue = create<{ chips: PendingChip[] }>(() => ({ chips: [] }))

/** Show intent immediately, but don't let queue actions operate on an unconfirmed chip. */
export function showPendingChip(sessionId: string, behavior: 'steer' | 'followUp', text: string) {
  const id = crypto.randomUUID()
  const kind = behavior === 'steer' ? 'steer' : 'follow-up'
  usePendingQueue.setState(({ chips }) => ({ chips: [...chips, { id, sessionId, kind, text }] }))
  return {
    dispatch(prompt: string) {
      const key = kind === 'steer' ? 'steering' : 'followUp'
      const confirmed = useChatStore.getState().sessions[sessionId]?.queues[key] ?? []
      const match = {
        text: prompt,
        previousCount: confirmed.filter((entry) => entry === prompt).length,
      }
      usePendingQueue.setState(({ chips }) => ({
        chips: chips.map((chip) => (chip.id === id ? { ...chip, match } : chip)),
      }))
    },
    remove() {
      usePendingQueue.setState(({ chips }) => ({ chips: chips.filter((chip) => chip.id !== id) }))
    },
  }
}
