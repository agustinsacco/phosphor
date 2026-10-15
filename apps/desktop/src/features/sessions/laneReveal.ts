import { useEffect, useRef } from 'react'
import { create } from 'zustand'

const useReveal = create(() => ({ seq: 0, groupKey: null as string | null }))
export function requestReveal(groupKey: string): void {
  useReveal.setState((s) => ({ seq: s.seq + 1, groupKey }))
}
export function hostGroupKey(hostId: string, repositoryId: string): string {
  return `host:${hostId}:${repositoryId}`
}
export function useLaneReveal(groupKey: string, reveal: () => void): void {
  const request = useReveal()
  const seen = useRef(0)
  useEffect(() => {
    if (request.groupKey === groupKey && request.seq > seen.current) {
      seen.current = request.seq
      reveal()
    }
  }, [request, groupKey, reveal])
}
