import { useEffect, useMemo } from 'react'
import type { MachineProvider } from '@shared/host-protocol-machine'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { machineCatalogueKey, useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { hostModelUnavailability, type ModelChoice } from './remoteModel'

const NO_PROVIDERS: readonly MachineProvider[] = []

/**
 * A Host lane's menu blocks exactly what the new-lane picker blocks, from the
 * same machine catalogue. `active` reads the catalogue only while the menu is
 * open; it is cached per connection. Undefined on This Mac.
 */
export function useHostModelUnavailability(
  hostId: string | null,
  models: readonly ModelChoice[],
  active: boolean,
): Map<string, { detail: string }> | undefined {
  const generation = useRemoteLanesStore(() => (hostId ? machineReadGeneration(hostId) : 0))
  const providers = useMachineCataloguesStore((s) =>
    hostId
      ? (s.catalogues[machineCatalogueKey(hostId, generation)]?.providers ?? NO_PROVIDERS)
      : NO_PROVIDERS,
  )
  useEffect(() => {
    if (hostId && active) void useMachineCataloguesStore.getState().load(hostId)
  }, [hostId, active, generation])
  return useMemo(
    () => (hostId ? hostModelUnavailability(models, providers, machineLabel(hostId)) : undefined),
    [hostId, models, providers],
  )
}
