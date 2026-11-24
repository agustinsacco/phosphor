import { brainBriefing, type BrainClient } from './client'
import { validateBrainRequest } from './validate'

/** Only the owner binds lane facts. No extension-supplied path, id, title or memory id is trusted. */
export function createLaneBrain(
  client: BrainClient,
  lane: { cwd: string; sessionId: string; title: string },
) {
  let refs = new Map<number, string>()
  return {
    async search(input: Readonly<Record<string, unknown>>) {
      refs.clear()
      const query = validateBrainRequest('search', {
        query: input.query,
        from: input.from,
        to: input.to,
        context: input.context,
        limit: input.limit,
        cwd: lane.cwd,
        sessionId: lane.sessionId,
      })
      const result = await client.search(query)
      const briefing = brainBriefing(result, lane.cwd)
      refs = briefing.refs
      const memories = result.mode === 'route' ? result.memories.length : result.hits.length
      return { text: briefing.text, data: { status: result.status, memories } }
    },
    async flag(input: Readonly<Record<string, unknown>>) {
      const memoryId = typeof input.ref === 'number' && refs.get(input.ref)
      if (!memoryId)
        return {
          text: 'That number is not in the latest Brain briefing for this lane; search again first.',
          data: { status: 'unavailable' },
        }
      const params = validateBrainRequest('flag', {
        memoryId,
        problem: input.problem,
        reason: input.reason,
        sessionId: lane.sessionId,
        title: (lane.title.trim() || 'Lane').slice(0, 120),
      })
      const result = await client.flag(params)
      return { text: result.message, data: { status: result.status } }
    },
  }
}
