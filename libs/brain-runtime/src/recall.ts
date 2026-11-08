import type { BrainAgentMap, BrainAgentMethod, BrainRecall } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { validateBrainRequest } from '@phosphor/brain-client/validate'
import type { BrainServiceOptions, BrainRecallLaunch } from './types'
import { projectContext } from './lane'
import { createBrainBridge } from './bridge'

function scopeResolver(): (cwd?: string) => Promise<string | null> {
  const scopes = new Map<string, Promise<string>>()
  return async (cwd) => {
    if (!cwd) return null
    let pending = scopes.get(cwd)
    if (!pending) {
      pending = projectContext(cwd).then((ctx) => ctx.scope)
      scopes.set(cwd, pending)
    }
    return pending
  }
}

export function createRecall(store: BrainStore, options: BrainServiceOptions) {
  const scope = scopeResolver()
  let bridge: ReturnType<typeof createBrainBridge> | undefined
  let disposed = false
  const enabled = (): boolean =>
    !disposed && store.snapshot().prefs.enabled && store.snapshot().prefs.recall
  async function agent<M extends BrainAgentMethod>(
    method: M,
    input: BrainAgentMap[M]['request'],
  ): Promise<BrainRecall> {
    if (!enabled()) return { status: 'unavailable', hits: [], entities: [], degradation: [] }
    const params = validateBrainRequest(method, input)
    const project = await scope(params.cwd)
    let result: BrainRecall
    if (method === 'search') {
      const query = (params as BrainAgentMap['search']['request']).query
      const vector = await options.embeddings
        .embed([query], 'query')
        .then((rows) => (rows[0] ? new Float32Array(rows[0]) : null))
        .catch(() => null)
      if (!enabled()) return { status: 'unavailable', hits: [], entities: [], degradation: [] }
      result = store.search({ query, vector, scope: project, limit: params.limit ?? 6 })
    } else {
      if (!enabled()) return { status: 'unavailable', hits: [], entities: [], degradation: [] }
      result = store.related(
        (params as BrainAgentMap['related']['request']).entity,
        params.limit ?? 12,
        project,
      )
    }
    if (params.sessionId)
      store.recordDelivery(
        params.sessionId,
        result.hits.map((h) => h.memory.id),
      )
    options.onChange?.()
    return result
  }
  async function recallLaunch(): Promise<BrainRecallLaunch | undefined> {
    try {
      if (!enabled()) return undefined
      bridge ??= createBrainBridge((method, params) =>
        agent(method, validateBrainRequest(method, params)),
      )
      const connection = await bridge
      if (!enabled()) return undefined
      return {
        env: {
          PHOSPHOR_BRAIN_ENDPOINT: connection.endpoint,
          PHOSPHOR_BRAIN_TOKEN: connection.token,
        },
        extensions: [options.recall.extension],
        skills: [options.recall.skill],
      }
    } catch (error) {
      bridge = undefined
      options.log?.('Brain recall unavailable', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      return undefined
    }
  }
  return {
    agent,
    recallLaunch,
    async dispose() {
      disposed = true
      await bridge?.then((b) => b.close()).catch(() => undefined)
    },
  }
}
