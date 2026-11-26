import { create } from 'zustand'
import type { HostResourceChangedEvent } from '@shared/ipc'

type Kind = HostResourceChangedEvent['kind']
export const useHostResourceChanges = create<Record<string, number>>(() => ({}))

export function useHostResourceRevision(hostId: string | null, kind: Kind): number {
  return useHostResourceChanges((state) => (hostId ? (state[`${hostId}:${kind}`] ?? 0) : 0))
}

/** Host hints are advisory, not the authoritative data. Coalesce a burst per machine and kind. */
export function attachHostResourceChanges(): () => void {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const off = window.phosphor.onHostResourceChanged?.(({ hostId, kind }) => {
    const key = `${hostId}:${kind}`
    clearTimeout(pending.get(key))
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key)
        const all = `*:${kind}`
        useHostResourceChanges.setState((state) => ({
          [key]: (state[key] ?? 0) + 1,
          [all]: (state[all] ?? 0) + 1,
        }))
      }, 100),
    )
  })
  return () => {
    off?.()
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    useHostResourceChanges.setState({}, true)
  }
}
