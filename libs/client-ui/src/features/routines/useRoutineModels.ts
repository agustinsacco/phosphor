import { usePlatform } from '@/platform/Platform'
import { useEffect } from 'react'
import { useMachineCatalogue, useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { catalogueEmptyText, useModelCatalogueStore } from '@/stores/modelCatalogue'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'

/** Routine model choices belong to their execution machine, not the active lane. */
export function useRoutineModels(machineId?: string) {
  const { localLanes } = usePlatform()
  const hostId = machineId?.startsWith('host:') ? machineId.slice(5) : null
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const remote = useMachineCatalogue(hostId)
  const models = useModelCatalogueStore((s) => s.models)
  const providers = useModelCatalogueStore((s) => s.providers)
  const status = useModelCatalogueStore((s) => s.status)
  const source = useModelCatalogueStore((s) => s.source)
  useEffect(() => {
    if (!hostId && localLanes) void useModelCatalogueStore.getState().hydrate()
  }, [hostId, localLanes])
  if (hostId)
    return {
      models:
        host?.state === 'ready' && host.capabilities.includes('skills.read') ? remote.models : [],
      loading: remote.status === 'idle' || remote.status === 'loading',
      emptyText: REMOTE_UNAVAILABLE,
      refresh: () => void useMachineCataloguesStore.getState().load(hostId, undefined, true),
    }
  return {
    models: localLanes ? models : [],
    loading: localLanes && (status === 'idle' || status === 'loading'),
    emptyText: localLanes
      ? catalogueEmptyText(status, providers)
      : 'Choose a machine to see its models.',
    refresh: () => {
      if (localLanes && source === 'config') void useModelCatalogueStore.getState().refresh()
    },
  }
}
