import type { ThinkingLevel } from '@shared/rpc'
import { useMachinesStore } from './machines'
import { create } from 'zustand'
import type { ModelChoice } from '@/features/machines/remoteModel'

/** Last-used remote models belong to this window and their Host, never local pi defaults. */
export const useRemoteModelPicks = create<{
  last: Record<string, ModelChoice>
  thinking: Record<string, ThinkingLevel>
}>(() => ({
  last: {},
  thinking: {},
}))

export function rememberRemoteModel(hostId: string, choice: ModelChoice): void {
  useRemoteModelPicks.setState((s) => ({
    last: Object.fromEntries(
      [...Object.entries(s.last).filter(([id]) => id !== hostId), [hostId, choice]].slice(-64),
    ),
  }))
}

export function rememberRemoteThinking(hostId: string, level: ThinkingLevel): void {
  useRemoteModelPicks.setState((s) => ({
    thinking: Object.fromEntries(
      [...Object.entries(s.thinking).filter(([id]) => id !== hostId), [hostId, level]].slice(-64),
    ),
  }))
}

useMachinesStore.subscribe((state) => {
  if (!state.remoteEnabled) useRemoteModelPicks.setState({ last: {}, thinking: {} })
})
