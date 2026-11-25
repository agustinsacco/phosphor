import { create } from 'zustand'
import { useChatStore } from '@/stores/chat'

interface PendingChip {
  id: string
  sessionId: string
  kind: 'steer' | 'follow-up'
  text: string
  /** Occurrence in pi's queue, including older identical messages. */
  occurrence: number
}

export const usePendingQueue = create<{ chips: PendingChip[] }>(() => ({ chips: [] }))

/** Show intent immediately, but don't let queue actions operate on an unconfirmed chip. */
export function showPendingChip(sessionId: string, behavior: 'steer' | 'followUp', text: string) {
  const id = crypto.randomUUID()
  const kind = behavior === 'steer' ? 'steer' : 'follow-up'
  const key = kind === 'steer' ? 'steering' : 'followUp'
  const confirmed = useChatStore.getState().sessions[sessionId]?.queues[key] ?? []
  usePendingQueue.setState(({ chips }) => {
    let previous = confirmed.filter((entry) => entry === text).length
    for (const chip of chips) {
      if (chip.sessionId === sessionId && chip.kind === kind && chip.text === text)
        previous = Math.max(previous, chip.occurrence)
    }
    return { chips: [...chips, { id, sessionId, kind, text, occurrence: previous + 1 }] }
  })
  return () =>
    usePendingQueue.setState(({ chips }) => ({ chips: chips.filter((c) => c.id !== id) }))
}
