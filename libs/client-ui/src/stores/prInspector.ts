import { create } from 'zustand'
import type { GhPrKey } from '@shared/models'

/**
 * A request to open a lane's PR inspector, optionally on one PR. A notice's
 * "Open lane", the sidebar's "Pull requests" menu and the Home board ask; the
 * lane's header pill answers once that lane is on screen, then clears it.
 * A request no pill answers in `PR_INSPECTOR_REQUEST_MS` lapses: the lane
 * never showed a pill (PR status off), or the user moved on before it loaded.
 */
export interface PrInspectorRequest {
  sessionId: string
  /** The PR to select; the lane's lead PR when absent. */
  key?: GhPrKey
  at: number
}

export const PR_INSPECTOR_REQUEST_MS = 15_000

interface PrInspectorState {
  request: PrInspectorRequest | null
  open: (sessionId: string, key?: GhPrKey) => void
  /** Take the request if it is for this lane and has not lapsed. */
  take: (sessionId: string, now?: number) => PrInspectorRequest | null
}

export const usePrInspectorStore = create<PrInspectorState>((set, get) => ({
  request: null,
  open: (sessionId, key) =>
    set({ request: { sessionId, ...(key ? { key } : {}), at: Date.now() } }),
  take: (sessionId, now = Date.now()) => {
    const request = get().request
    if (request?.sessionId !== sessionId) return null
    set({ request: null })
    return now - request.at > PR_INSPECTOR_REQUEST_MS ? null : request
  },
}))
