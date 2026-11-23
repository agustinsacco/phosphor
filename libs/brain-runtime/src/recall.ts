import type {
  BrainAgentMethod,
  BrainQuery,
  BrainRecall,
  BrainAgentMap,
} from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { validateBrainRequest } from '@phosphor/brain-client/validate'
import type { BrainService, BrainServiceOptions, BrainRecallLaunch, BrainSearchPort } from './types'
import { projectContext } from './lane'
import { createLaneBrain } from '@phosphor/brain-client/lane'
import { brainFlagLimit } from './tidy/flag-limit'
import { fileBrainFlag, flagResponse, type BrainFlagPort } from './tidy/flag'

const unavailable = (): BrainRecall => ({
  status: 'unavailable',
  hits: [],
  entities: [],
  focus: [],
  paths: [],
  branch: null,
  more: 0,
  degradation: [],
})

export function createRecall(
  store: BrainStore,
  options: BrainServiceOptions,
  search: BrainSearchPort,
  accepting: () => boolean = () => true,
  flags?: BrainFlagPort,
) {
  let disposed = false
  const enabled = (): boolean =>
    !disposed && accepting() && store.snapshot().prefs.enabled && store.snapshot().prefs.recall
  async function recall(input: BrainQuery): Promise<BrainRecall> {
    if (!enabled()) return unavailable()
    const params = validateBrainRequest('search', input)
    const project = params.cwd ? await projectContext(params.cwd) : { scope: null, branch: null }
    const vector = await options.embeddings
      .embed([params.query], 'query')
      .then((rows) => (rows[0] ? new Float32Array(rows[0]) : null))
      .catch(() => null)
    if (!enabled()) return unavailable()
    const result = await search.recall({
      query: params.query,
      vector,
      scope: project.scope,
      branch: project.branch,
      now: (options.now ?? Date.now)(),
      limit: params.limit ?? 8,
    })
    return result
  }
  async function agent<M extends BrainAgentMethod>(
    method: M,
    input: BrainAgentMap[M]['request'],
  ): Promise<BrainAgentMap[M]['result']> {
    const result =
      method === 'search'
        ? await recall(validateBrainRequest('search', input))
        : enabled() && flags
          ? fileBrainFlag(store, flags, input)
          : flagResponse('unavailable')
    if (method === 'flag' && result.status === 'filed') options.onChange?.()
    return result as BrainAgentMap[M]['result']
  }
  async function recallLaunch(): Promise<BrainRecallLaunch | undefined> {
    try {
      if (!enabled()) return undefined
      return {
        extensions: [options.recall.extension],
        skills: [options.recall.skill],
      }
    } catch (error) {
      options.log?.('Brain recall unavailable', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      return undefined
    }
  }
  return {
    agent,
    forLane: (lane: Parameters<BrainService['forLane']>[0]) =>
      createLaneBrain(
        {
          search: (query) => agent('search', query),
          flag: async (params) => brainFlagLimit() ?? (await agent('flag', params)),
        },
        lane,
      ),
    recallLaunch,
    async dispose() {
      disposed = true
    },
  }
}
