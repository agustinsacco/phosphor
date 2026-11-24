import type { BrainExpansion } from '@phosphor/shared/brain-recall'
import { entity as profile } from './explorer'
import { entity, referencedEntities } from './entities'
import { memoryCards } from './knowledge'
import { ppr } from './ppr'
import { RECALL_TUNING } from './recall-tuning'
import type { Context } from './database'
import type { BrainSearch } from './types'

export function expand(
  ctx: Context,
  input: Parameters<BrainSearch['expand']>[0],
  tuning = RECALL_TUNING,
): BrainExpansion {
  const { entityId, now } = input
  const self = entity(ctx, entityId)
  const empty: BrainExpansion = {
    mode: 'expand',
    status: 'no_match',
    entity: null,
    alternatives: [],
    current: [],
    ended: [],
    together: [],
    togetherMore: 0,
    hits: [],
    entities: [],
    degradation: [],
  }
  if (!self) return empty
  const focus = new Set([entityId, ...input.contextIds.slice(0, 5)])
  const ranked = ppr(
    ctx,
    {
      entities: new Map([...focus].map((id) => [id, tuning.focusSeed])),
      focus,
      memories: new Map(),
    },
    now,
    tuning,
  )
  const view = profile(ctx, entityId, now)
  const order = new Map(ranked.entities.map((id, i) => [id, i]))
  const line = ({ link, entity: other, supports }: (typeof view.ended)[number]) => ({
    link,
    other,
    supports,
  })
  const current = view.groups
    .flatMap((group) => group.items.map(line))
    .sort((a, b) => (order.get(a.other.id) ?? Infinity) - (order.get(b.other.id) ?? Infinity))
  const hits = memoryCards(ctx, ranked.memories)
    .filter((m) => m.entityIds.includes(entityId))
    .slice(0, Math.max(0, Math.min(20, input.limit)))
    .map((memory, i) => ({
      memory,
      score: 1 / (1 + i),
      reasons: ['linked' as const],
      trail: ranked.trails.get(memory.id) ?? null,
    }))
  const entities = referencedEntities(ctx, [
    ...hits.map((h) => h.memory),
    { entityIds: [...focus] },
  ])
  return {
    ...empty,
    status: 'ok',
    entity: self,
    current,
    ended: view.ended.map(line),
    together: view.together,
    togetherMore: view.togetherMore,
    hits,
    entities,
  }
}
