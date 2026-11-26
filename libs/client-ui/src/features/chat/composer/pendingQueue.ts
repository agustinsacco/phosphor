import { create } from 'zustand'
import { useChatStore } from '@/stores/chat'

interface PendingChip {
  id: string
  sessionId: string
  kind: 'steer' | 'follow-up'
  text: string
}

export const usePendingQueue = create<{ chips: PendingChip[] }>(() => ({ chips: [] }))

/** Show intent immediately, but don't let queue actions operate on an unconfirmed chip. */
export function showPendingChip(sessionId: string, behavior: 'steer' | 'followUp', text: string) {
  const id = crypto.randomUUID()
  const kind = behavior === 'steer' ? 'steer' : 'follow-up'
  usePendingQueue.setState(({ chips }) => ({ chips: [...chips, { id, sessionId, kind, text }] }))
  let unsubscribe: (() => void) | undefined
  const remove = () => {
    unsubscribe?.()
    unsubscribe = undefined
    usePendingQueue.setState(({ chips }) => ({ chips: chips.filter((chip) => chip.id !== id) }))
  }
  return {
    dispatch(prompt: string) {
      const key = kind === 'steer' ? 'steering' : 'followUp'
      const queue = (s: ReturnType<typeof useChatStore.getState>) =>
        s.sessions[sessionId]?.queues[key]
      const count = (entries: string[] | undefined) =>
        entries?.filter((entry) => entry === prompt).length ?? 0
      let previousCount = count(queue(useChatStore.getState()))
      // Observe each queue change, even when React batches consumption and re-queueing.
      unsubscribe = useChatStore.subscribe((state, prev) => {
        const entries = queue(state)
        if (entries === queue(prev)) return
        const matching = count(entries)
        if (matching > previousCount)
          remove() // Confirmed chips must not return as provisional.
        else previousCount = matching // Older identical entries may be delivered during preflight.
      })
    },
    remove,
  }
}
