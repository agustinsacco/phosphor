import type { MachineView } from '@phosphor/shared/control-api'

/** Directory state behind the real Control routes. Omitted reach models pre-upgrade control. */
export function directoryRpc(
  name: 'control_machines' | 'control_machine_reach_list' | 'control_machine_reach_set',
  args: Record<string, unknown>,
  owner: string,
  machine: MachineView,
  state: { machineReach?: boolean },
) {
  switch (name) {
    case 'control_machines':
      return {
        machines:
          args.p_user_id === owner ? [{ ...machine, lastSeenAt: new Date().toISOString() }] : [],
        serverTime: new Date().toISOString(),
      }
    case 'control_machine_reach_list':
      return state.machineReach === undefined || args.p_user !== owner
        ? []
        : [{ id: machine.id, machineReach: state.machineReach, machineGrants: true }]
    case 'control_machine_reach_set':
      if (
        state.machineReach === undefined ||
        args.p_host !== machine.id ||
        args.p_user !== owner ||
        typeof args.p_enabled !== 'boolean'
      )
        return { outcome: 'not-found' }
      state.machineReach = args.p_enabled
      return { outcome: 'set', machineReach: state.machineReach }
  }
}
