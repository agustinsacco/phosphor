import { create } from 'zustand'
import type { GhPrKey } from '@shared/models'

/**
 * A request to open a lane's PR inspector, optionally on one PR. A notice's
 * "Open lane", the sidebar's "Pull requests" menu and the Home board ask; the
 * lane's header pill answers once that lane is on screen, then clears it.
 */
export interface PrInspectorRequest {
  sessionId: string
  /** The PR to select; the lane's lead PR when absent. */
  key?: GhPrKey
  at: number
}

interface PrInspectorState {
  request: PrInspectorRequest | null
  open: (sessionId: string, key?: GhPrKey) => void
  /** Take the request if it is for this lane. */
  take: (sessionId: string) => PrInspectorRequest | null
}

export const usePrInspectorStore = create<PrInspectorState>((set, get) => ({
  request: null,
  open: (sessionId, key) =>
    set({ request: { sessionId, ...(key ? { key } : {}), at: Date.now() } }),
  take: (sessionId) => {
    const request = get().request
    if (request?.sessionId !== sessionId) return null
    set({ request: null })
    return request
  },
}))
