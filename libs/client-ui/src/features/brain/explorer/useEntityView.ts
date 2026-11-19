import { useCallback } from 'react'
import { useBrainResource } from '../useBrainResource'

/** One entity's view, reloaded with Brain's revision; every failure has Retry. */
export function useEntityView(id: string | null) {
  const load = useCallback(() => window.phosphor.invoke('brain:entity', id ?? ''), [id])
  return useBrainResource(load, !!id)
}
