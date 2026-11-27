import { BRAIN_POSSIBLE_REPEATS_PER_RUN } from '@phosphor/shared/brain-agent'
import { curatorWrites } from './curator-writes'
import { curatorEntity, curatorMemory, curatorRecall, curatorSuggestion } from './curator-view'
import { BRAIN_OFF, type CuratorApi, type CuratorContext } from './curator-context'
import { BRAIN_TURN_REFUSAL, curatorTurn } from './curator-turn'

import { searchQuery } from '../search/query'

export function createCurator(context: CuratorContext): CuratorApi {
  const { store, search, options } = context
  const on = (): void => {
    if (!context.enabled()) throw new Error(BRAIN_OFF)
    if (!curatorTurn(context)) throw new Error(BRAIN_TURN_REFUSAL)
  }
  return {
    waiting: async (request) => {
      on()
      return {
        counts: store.waitingCounts(),
        ...store.waitingSuggestions(request.limit ?? 60, BRAIN_POSSIBLE_REPEATS_PER_RUN),
      }
    },
    suggestion: async ({ suggestionId }) => {
      on()
      return curatorSuggestion(store.agentSuggestion(suggestionId))
    },
    entity: async ({ entityId }) => {
      on()
      return curatorEntity(store.entity(entityId))
    },
    memory: async ({ memoryId }) => {
      on()
      return curatorMemory(store.memory(memoryId))
    },
    search: async (request) => {
      on()
      return curatorRecall(
        await searchQuery(request, options, search, { scope: null, branch: null }, context.enabled),
      )
    },
    ...curatorWrites(context),
  }
}
