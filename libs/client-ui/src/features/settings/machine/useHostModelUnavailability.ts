import { useMemo } from 'react'
import { useMachineCatalogue } from '@/stores/machineCatalogues'
import { machineLabel } from '@/stores/remoteLanes'
import { hostModelUnavailability, type ModelChoice } from '@/features/machines/remoteModel'

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
  const { providers } = useMachineCatalogue(hostId, active)
  return useMemo(
    () => (hostId ? hostModelUnavailability(models, providers, machineLabel(hostId)) : undefined),
    [hostId, models, providers],
  )
}
