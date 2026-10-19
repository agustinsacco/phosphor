import { create } from 'zustand'
import { useRemoteModelPicks } from '@/stores/remoteModelPicks'
import { useMachinesStore } from '@/stores/machines'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

/** One pending repository selection per window, not a history of lanes. */
export const useRemoteComposer = create<{
  target: { hostId: string; repositoryId: string } | null
  repositories: Record<string, string>
}>(() => ({ target: null, repositories: {} }))

export function rememberRemoteRepository(hostId: string, repositoryId: string): void {
  useRemoteComposer.setState((s) => ({
    repositories: Object.fromEntries(
      [
        ...Object.entries(s.repositories).filter(([id]) => id !== hostId),
        [hostId, repositoryId],
      ].slice(-64),
    ),
  }))
}

export function openRemoteComposer(hostId: string, repositoryId?: string): void {
  const host = useRemoteLanesStore.getState().hosts[hostId]
  const remembered = useRemoteComposer.getState().repositories[hostId]
  repositoryId ??=
    host?.repositories.find((repo) => repo.id === remembered)?.id ?? host?.repositories[0]?.id ?? ''
  rememberRemoteRepository(hostId, repositoryId)
  useRemoteComposer.setState({ target: { hostId, repositoryId } })
  useRemoteLanesStore.getState().setFilter(hostId)
  useSessionsStore.getState().activate(null)
}

useMachinesStore.subscribe((state, previous) => {
  const target = useRemoteComposer.getState().target
  if (!state.remoteEnabled) {
    useRemoteComposer.setState({ target: null, repositories: {} })
    return
  }
  if (
    target &&
    previous.machines.some((m) => m.id === target.hostId) &&
    !state.machines.some((m) => m.id === target.hostId)
  )
    useRemoteComposer.setState({ target: null })
})

useRemoteLanesStore.subscribe((state, previous) => {
  const target = useRemoteComposer.getState().target
  if (state.filter !== previous.filter && target?.hostId !== state.filter)
    useRemoteComposer.setState({ target: null })
})

/** Called by browser owner cleanup before another account can mount creation. */
export function clearRemoteStartMemory(): void {
  useRemoteComposer.setState({ target: null, repositories: {} })
  useRemoteModelPicks.setState({ last: {}, thinking: {} })
}
