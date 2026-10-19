import {
  machineRecord,
  parseMachineClaude,
  parseMachineClaudeUsage,
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
  /** A newer call an older Host refuses: any failure, or a changed connection, is null. */
  async function optional<T>(
    hostId: string,
    method: string,
    params: Record<string, unknown>,
    parse: (data: unknown) => T | null,
  ): Promise<T | null> {
    const c = connection(hostId)
    if (!c) return null
    const ready = () =>
      c.snapshot().state === 'ready' && c.snapshot().capabilities.includes('skills.read')
    if (!ready() || !parseMachineParams(method, params)) return null
    const generation = c.incarnation().generation
    try {
      const reply = await c.call(method, params)
      if (connection(hostId) !== c || c.incarnation().generation !== generation || !ready())
        return null
      return reply.ok ? parse(reply.data) : null
    } catch {
      return null
    }
  }
  return {
    lane,
    claude: (hostId: string) => optional(hostId, 'machine.claude', {}, parseMachineClaude),
    /** Plan usage of the account this lane bills on the Host. null: unavailable or an older Host. */
    claudeUsage: (hostId: string, laneId?: string, force?: boolean) =>
      optional(
        hostId,
        'machine.claudeUsage',
        { ...(laneId ? { laneId } : {}), ...(force ? { force: true } : {}) },
        parseMachineClaudeUsage,
      ),
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
