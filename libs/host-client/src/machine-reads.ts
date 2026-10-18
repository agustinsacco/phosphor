import {
  machineRecord,
  parseMachineClaude,
  parseMachineModels,
  parseMachineParams,
  parseMachineProviders,
} from '@phosphor/shared/host-protocol-machine'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'
import { readFeature, type ReadLane } from './read-features'
import type { SkillsListResult } from '@phosphor/shared/skills'

/** Catalogues are machine-scoped; no lane or Host path is needed. */
export function machineReads(
  connection: (
    hostId: string,
  ) =>
    Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'incarnation' | 'call'> | undefined,
) {
  function lane(hostId: string): ReadLane {
    const c = connection(hostId)
    if (!c) throw new Error(REMOTE_UNAVAILABLE)
    const incarnation = c.incarnation()
    const available = () =>
      connection(hostId) === c &&
      c.incarnation().generation === incarnation.generation &&
      c.snapshot().state === 'ready' &&
      c.snapshot().capabilities.includes('skills.read')
    return {
      workspacePath: `host:${hostId}/machine`,
      async call(_capability, method, params) {
        const parsed = parseMachineParams(method, params)
        if (!parsed || !available()) throw new Error(REMOTE_UNAVAILABLE)
        try {
          const result = await c.call(method, parsed)
          if (!available() || !result.ok) throw new Error(REMOTE_UNAVAILABLE)
          return result.data
        } catch {
          throw new Error(REMOTE_UNAVAILABLE)
        }
      },
    }
  }
  return {
    lane,
    async claude(hostId: string) {
      const c = connection(hostId)
      if (
        !c ||
        c.snapshot().state !== 'ready' ||
        !c.snapshot().capabilities.includes('skills.read')
      )
        return null
      const generation = c.incarnation().generation
      try {
        const reply = await c.call('machine.claude', {})
        if (
          connection(hostId) !== c ||
          c.incarnation().generation !== generation ||
          c.snapshot().state !== 'ready' ||
          !c.snapshot().capabilities.includes('skills.read')
        )
          return null
        return reply.ok ? parseMachineClaude(reply.data) : null
      } catch {
        return null
      }
    },
    async models(hostId: string) {
      const data = await lane(hostId).call('skills.read', 'machine.models', {})
      const result = machineRecord(data) ? parseMachineModels(data.models) : null
      if (!result) throw new Error(REMOTE_UNAVAILABLE)
      return result
    },
    async providers(hostId: string) {
      const data = await lane(hostId).call('skills.read', 'machine.providers', {})
      const result = machineRecord(data) ? parseMachineProviders(data.providers) : null
      if (!result) throw new Error(REMOTE_UNAVAILABLE)
      return result
    },
    async skills(hostId: string): Promise<SkillsListResult> {
      // readFeature projects the same reviewed, read-only skill fields as lane reads.
      return readFeature('skills:list', [], lane(hostId))
    },
  }
}
