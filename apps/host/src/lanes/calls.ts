import type { CallOutcome } from './service'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { HostFeature } from '../features/feature'
import { laneQueryCapability, resolveLaneQuery, type LaneQueryOptions } from './calls/query'

export function createLaneCalls(options: LaneQueryOptions & { features?: readonly HostFeature[] }) {
  const features = new Map<string, HostFeature>()
  for (const feature of options.features ?? [])
    for (const method of feature.methods) features.set(method, feature)
  return {
    capabilityFor(method: string): HostCapability | null {
      return laneQueryCapability(method) ?? features.get(method)?.capability ?? null
    },
    async call(method: string, params: unknown, authorized?: () => boolean): Promise<CallOutcome> {
      const feature = features.get(method)
      if (feature)
        return authorized ? feature.call(method, params, authorized) : feature.call(method, params)
      return resolveLaneQuery(options, method, params)
    },
  }
}
