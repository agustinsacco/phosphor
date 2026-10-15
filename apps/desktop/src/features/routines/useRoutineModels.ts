import { useEffect } from 'react'
import {
  useMachineCataloguesStore,
  machineCatalogueKey,
  EMPTY_MACHINE_CATALOGUE,
} from '@/stores/machineCatalogues'
import { catalogueEmptyText, useModelCatalogueStore } from '@/stores/modelCatalogue'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import { machineReadGeneration } from '@/stores/machineReadGeneration'

/** Routine model choices belong to their execution machine, not the active lane. */
export function useRoutineModels(machineId?: string) {
  const hostId = machineId?.startsWith('host:') ? machineId.slice(5) : null
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const generation = useRemoteLanesStore(() => (hostId ? machineReadGeneration(hostId) : 0))
  const remote = useMachineCataloguesStore(
    (s) => s.catalogues[machineCatalogueKey(hostId ?? '', generation)] ?? EMPTY_MACHINE_CATALOGUE,
  )
  const models = useModelCatalogueStore((s) => s.models)
  const providers = useModelCatalogueStore((s) => s.providers)
  const status = useModelCatalogueStore((s) => s.status)
  const source = useModelCatalogueStore((s) => s.source)
  useEffect(() => {
    if (hostId) void useMachineCataloguesStore.getState().load(hostId)
    else void useModelCatalogueStore.getState().hydrate()
  }, [hostId, generation])
  if (hostId)
    return {
      models:
        host?.state === 'ready' && host.capabilities.includes('skills.read') ? remote.models : [],
      loading: remote.status === 'idle' || remote.status === 'loading',
      emptyText: REMOTE_UNAVAILABLE,
      refresh: () => void useMachineCataloguesStore.getState().load(hostId, undefined, true),
    }
  return {
    models,
    loading: status === 'idle' || status === 'loading',
    emptyText: catalogueEmptyText(status, providers),
    refresh: () => {
      if (source === 'config') void useModelCatalogueStore.getState().refresh()
    },
  }
}
