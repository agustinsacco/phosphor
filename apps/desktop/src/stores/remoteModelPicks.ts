import { create } from 'zustand'
import type { ModelChoice } from '@/features/machines/remoteModel'

/** Last-used remote models belong to this window and their Host, never local pi defaults. */
export const useRemoteModelPicks = create<{ last: Record<string, ModelChoice> }>(() => ({
  last: {},
}))

export function rememberRemoteModel(hostId: string, choice: ModelChoice): void {
  useRemoteModelPicks.setState((s) => ({ last: { ...s.last, [hostId]: choice } }))
}
