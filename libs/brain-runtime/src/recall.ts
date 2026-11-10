import type { BrainAgentMethod, BrainQuery, BrainRecall } from '@phosphor/shared/brain'
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

const unavailable = (): BrainRecall => ({
  status: 'unavailable',
  hits: [],
  entities: [],
  focus: [],
  links: [],
  more: 0,
  degradation: [],
})

export function createRecall(store: BrainStore, options: BrainServiceOptions) {
  const scope = scopeResolver()
  let bridge: ReturnType<typeof createBrainBridge> | undefined
  let disposed = false
  const enabled = (): boolean =>
    !disposed && store.snapshot().prefs.enabled && store.snapshot().prefs.recall
  async function agent(method: BrainAgentMethod, input: BrainQuery): Promise<BrainRecall> {
    if (!enabled()) return unavailable()
    const params = validateBrainRequest(method, input)
    const project = await scope(params.cwd)
    const vector = await options.embeddings
      .embed([params.query], 'query')
      .then((rows) => (rows[0] ? new Float32Array(rows[0]) : null))
      .catch(() => null)
    if (!enabled()) return unavailable()
    const result = store.search({
      query: params.query,
      vector,
      scope: project,
      limit: params.limit ?? 8,
    })
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
