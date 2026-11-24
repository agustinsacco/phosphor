import { AGENT_POLICY_DEFAULT, parseAgentPolicy } from '@phosphor/shared/ops'
import type { PolicyStore } from '@phosphor/session-runtime/ops/types'
import { prefs } from './backend'

/** Absence is an old profile, not an opt-out; a malformed policy fails closed. */
export function desktopAgentPolicy(value: unknown) {
  return value === undefined
    ? AGENT_POLICY_DEFAULT
    : (parseAgentPolicy(value) ?? {
        ...AGENT_POLICY_DEFAULT,
        agentControl: 'off' as const,
        machineOps: 'off' as const,
      })
}
export const policyStore: PolicyStore = {
  async read() {
    return { policy: desktopAgentPolicy(prefs().get('agentPolicy')), changedOutside: false }
  },
  async write(policy) {
    const parsed = parseAgentPolicy(policy)
    if (!parsed) throw new Error('Invalid policy.')
    prefs().set('agentPolicy', parsed)
  },
}
