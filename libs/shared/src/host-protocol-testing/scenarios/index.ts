import type { HostCapability } from '../../remote-host'
import { describeConformance } from '../conformance/context'
import type { HostConformanceFactory } from '../conformance/types'
import { localScenarios } from './local'
import { machineScenarios } from './machine'
import { opsScenarios, type ConformancePrincipal } from './ops'
import { ownerScenarios } from './owner'

export { MACHINE_CONFORMANCE_ID, principalClaims, type ConformancePrincipal } from './ops'

/**
 * Agent-control scenarios, apart from `defineHostConformance` so its frozen
 * registration order and titles never change. `principal` picks the grant
 * every scenario connection presents.
 */
export function defineAgentControlConformance(
  name: string,
  factory: HostConformanceFactory,
  options: { capabilities?: readonly HostCapability[]; principal?: ConformancePrincipal } = {},
) {
  const principal = options.principal ?? 'user'
  describeConformance(
    name,
    factory,
    options.capabilities ?? ['sessions.read', 'sessions.control'],
    [...opsScenarios(principal), ...ownerScenarios(), ...localScenarios(), ...machineScenarios()],
  )
}
