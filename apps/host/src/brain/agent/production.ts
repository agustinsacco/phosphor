import { dirname, join } from 'node:path'
import { createBrainAgentBinding } from './binding'
import { createBrainCuratorContribution } from './curator-contribution'
import { createHostBrainAgentLane } from './lane'
import { createBrainAgentLaunchProfile } from './profile'
import { hostBrainAgentReservation } from './reservation'
import type { HostRuntime } from '../../session/runtime'

/**
 * The conversation, the importer and the curator use the same private identity for this run,
 * and the conversation and the curator contribution the same launch profile. `guard` is the
 * bundle's tool guard (`hostBrainAgentGuard`), or null: then no person's message runs.
 */
export function createProductionBrainAgent(
  stateDirectory: string,
  sessionsRoot: string,
  log: (message: string, data?: Record<string, unknown>) => void,
  launch: Parameters<typeof createBrainCuratorContribution>[1],
  guard: string | null,
) {
  const lane = hostBrainAgentReservation(stateDirectory)
  const binding = createBrainAgentBinding(join(dirname(lane.folder), 'agent-lane.json'))
  const profile = createBrainAgentLaunchProfile(guard)
  return {
    binding,
    importBinding: {
      read: async () => (await binding.read()).sessionFile,
      bind: async (file: string | null) => {
        await binding.bind(file)
      },
    },
    contribution: createBrainCuratorContribution(lane, launch, profile),
    agent: ({ runtime }: { runtime: HostRuntime }) =>
      createHostBrainAgentLane({ runtime, lane, sessionsRoot, log, binding, profile }),
  }
}
