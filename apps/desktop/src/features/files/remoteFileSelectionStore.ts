import { create } from 'zustand'
import type { PendingReveal } from '@/stores/files'

// No store imports here: stores/sessions clears this state when it forgets a lane, and
// importing sessions or remoteLanes from this module would put them on one import cycle.
export const useRemoteFileSelection = create<{
  bySession: Record<string, { path: string; reveal?: PendingReveal }>
  blocked: Record<string, boolean>
}>(() => ({ bySession: {}, blocked: {} }))

export function releaseRemoteFileSelection(sessionId: string): void {
  useRemoteFileSelection.setState((s) => {
    const bySession = { ...s.bySession },
      blocked = { ...s.blocked }
    delete bySession[sessionId]
    delete blocked[sessionId]
    return { bySession, blocked }
  })
}
