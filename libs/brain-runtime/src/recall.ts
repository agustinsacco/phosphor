import type { BrainAgentMethod, BrainAgentMap } from '@phosphor/shared/brain'
import type { BrainQuery, BrainSearchResult } from '@phosphor/shared/brain-recall'
import { searchQuery, unavailable } from './search/query'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { validateBrainRequest } from '@phosphor/brain-client/validate'
import type {
  BrainCuratorLaunch,
  BrainRecallLaunch,
  BrainSearchPort,
  BrainService,
  BrainServiceOptions,
} from './types'
import { projectContext } from './lane'
import { createLaneBrain } from '@phosphor/brain-client/lane'
import { brainFlagLimit } from './tidy/flag-limit'
import { createBrainBridge, type BridgeRole } from './bridge'
import { fileBrainFlag, flagResponse, type BrainFlagPort } from './tidy/flag'
import type { CuratorApi } from './agent/curator-context'

type RecallStore = Pick<BrainStore, 'memory' | 'snapshot' | 'recordRecall'>

/** A lane's search: ranked for the lane's project and branch, while lane recall is on. */
function laneSearch(
  options: BrainServiceOptions,
  search: BrainSearchPort,
  enabled: () => boolean,
  store: RecallStore,
): (input: BrainQuery) => Promise<BrainSearchResult> {
  return async (input) => {
    if (!enabled()) return unavailable(input)
    const params = validateBrainRequest('search', input)
    const project = params.cwd ? await projectContext(params.cwd) : { scope: null, branch: null }
    const result = await searchQuery(params, options, search, project, enabled)
    if (!enabled()) return unavailable(input)
    const ids =
      result.mode === 'route'
        ? result.memories.map((m) => m.id)
        : result.hits.map((h) => h.memory.id)
    if (ids.length) store.recordRecall([...new Set(ids)], (options.now ?? Date.now)())
    return result
  }
}

/** One of Brain Agent's methods, on already validated parameters. */
async function callCurator(
  curator: CuratorApi | undefined,
  method: BrainAgentMethod,
  params: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!curator) throw new Error('Brain Agent is not available here.')
  const call = curator[method as keyof CuratorApi] as
    ((request: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
  if (!call) throw new Error('Brain request unavailable')
  return call(params, signal)
}

/** Every lane but the Brain lane reaches Brain through its op channel, so it gets no token. */
async function recallLaunch(
  options: BrainServiceOptions,
  enabled: () => boolean,
): Promise<BrainRecallLaunch | undefined> {
  try {
    if (!enabled()) return undefined
    return { extensions: [options.recall.extension], skills: [options.recall.skill] }
  } catch (error) {
    options.log?.('Brain recall unavailable', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return undefined
  }
}

/** A lane's op port; its flags share the service-wide window with the private bridge. */
function laneBrain(
  agent: <M extends 'search' | 'flag'>(
    method: M,
    input: BrainAgentMap[M]['request'],
  ) => Promise<BrainAgentMap[M]['result']>,
  lane: Parameters<BrainService['forLane']>[0],
) {
  return createLaneBrain(
    {
      search: (query) => agent('search', query),
      flag: async (params) => brainFlagLimit() ?? (await agent('flag', params)),
    },
    lane,
  )
}

/** The local bridge's two callers: any lane (recall and flags) and the Brain lane (curator). */
export function createRecall(
  store: RecallStore,
  options: BrainServiceOptions,
  search: BrainSearchPort,
  accepting: () => boolean = () => true,
  flags?: BrainFlagPort,
  curator?: CuratorApi,
) {
  let bridge: ReturnType<typeof createBrainBridge> | undefined
  let disposed = false
  const brainOn = (): boolean => !disposed && accepting() && store.snapshot().prefs.enabled
  const enabled = (): boolean => brainOn() && store.snapshot().prefs.recall
  const recall = laneSearch(options, search, enabled, store)
  /** Search and flag as any lane asks them; the curator's methods for the Brain lane. */
  async function agent<M extends BrainAgentMethod>(
    method: M,
    input: BrainAgentMap[M]['request'],
    signal: AbortSignal = new AbortController().signal,
    role: BridgeRole = 'lane',
  ): Promise<BrainAgentMap[M]['result']> {
    if (role === 'lane' && method !== 'search' && method !== 'flag')
      throw new Error('Brain request unavailable')
    const params = validateBrainRequest(method, input)
    if (role === 'curator')
      return (await callCurator(curator, method, params, signal)) as BrainAgentMap[M]['result']
    const result =
      method === 'search'
        ? await recall(params as BrainQuery)
        : enabled() && flags
          ? fileBrainFlag(store, flags, params)
          : flagResponse('unavailable')
    if (method === 'flag' && result.status === 'filed') options.onChange?.()
    return result as BrainAgentMap[M]['result']
  }
  async function connect() {
    bridge ??= createBrainBridge((method, params, signal, role) =>
      agent(method, params as never, signal, role),
    )
    return bridge
  }
  /** Brain Agent's tools need Brain on, not lane recall. */
  async function curatorLaunch(): Promise<BrainCuratorLaunch | undefined> {
    const resources = curator && options.curator
    try {
      if (!brainOn() || !resources) return undefined
      const connection = await connect()
      if (!brainOn()) return undefined
      return {
        connection: { endpoint: connection.endpoint, token: connection.curatorToken },
        extensions: [resources.extension],
        skills: [resources.skill],
      }
    } catch (error) {
      bridge = undefined
      options.log?.('Brain Agent tools unavailable', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      return undefined
    }
  }
  return {
    agent,
    forLane: (lane: Parameters<BrainService['forLane']>[0]) => laneBrain(agent, lane),
    recallLaunch: () => recallLaunch(options, enabled),
    curatorLaunch,
    async dispose() {
      disposed = true
      await bridge?.then((b) => b.close()).catch(() => undefined)
    },
  }
}
