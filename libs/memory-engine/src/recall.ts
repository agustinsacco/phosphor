import type { BrainHit, BrainMemory, BrainMemoryType, BrainRecall } from '@phosphor/shared/brain'
import { entity, referencedEntities } from './entities'
import { memoryCards } from './knowledge'
import { about, entitySeeds, lexicalIds, named, seedEntities } from './seeds'
import { walk } from './walk'
import type { Context } from './database'
import type { SearchInput, Neighbour } from './types'

const HALF_LIFE_DAYS: Record<BrainMemoryType, number> = {
  open: 30,
  risk: 60,
  decision: 180,
  fact: 180,
  procedure: 365,
  preference: 365,
}
export function freshness(memory: BrainMemory, now: number): number {
  const effective = memory.validFrom !== null && memory.validFrom <= now ? memory.validFrom : 0
  const days = Math.max(0, now - Math.max(memory.observedAt, effective)) / 86_400_000
  return 0.5 + 0.5 * 2 ** (-days / HALF_LIFE_DAYS[memory.type])
}
interface Nearest {
  entities: Neighbour[]
  memories: Neighbour[]
}
export function recall(
  ctx: Context,
  input: SearchInput,
  nearest: Nearest,
  degradation: string[],
): BrainRecall {
  const candidates = entitySeeds(ctx, input.query, 20)
  const focus = named(seedEntities(ctx, candidates), input.query).map((item) => item.id)
  const semantic = nearest.memories.filter((item) => item.score >= 0.35).map((item) => item.id)
  const semanticCards = memoryCards(ctx, semantic)
  const seeds = [
    ...new Set([
      ...focus,
      ...candidates,
      ...nearest.entities.filter((item) => item.score >= 0.35).map((item) => item.id),
      ...semanticCards.flatMap((item) => item.entityIds),
    ]),
  ].slice(0, 200)
  const lexical = lexicalIds(ctx, input.query)
  const exact = about(ctx, focus)
  const routes = walk(ctx, seeds, new Set(focus))
  const linked = [...new Set([...routes.memories, ...about(ctx, [...routes.entities])])].filter(
    (id) => !exact.includes(id),
  )
  const ranks: { ids: string[]; reason: BrainHit['reasons'][number]; weight: number }[] = [
    { ids: semantic, reason: 'semantic', weight: 2 },
    { ids: lexical, reason: 'lexical', weight: 1 },
    { ids: exact, reason: 'exact', weight: 1 },
    { ids: linked, reason: 'linked', weight: 0.5 },
  ]
  const scores = new Map<string, { score: number; reasons: BrainHit['reasons'] }>()
  for (const rank of ranks)
    rank.ids.forEach((id, index) => {
      const old = scores.get(id) ?? { score: 0, reasons: [] }
      old.score += rank.weight / (61 + index)
      if (!old.reasons.includes(rank.reason)) old.reasons.push(rank.reason)
      scores.set(id, old)
    })
  const supported = new Set(routes.memories)
  const hits: BrainHit[] = memoryCards(ctx, [...scores.keys()])
    .filter((memory) => memory.state !== 'superseded')
    .map((memory) => {
      const entry = scores.get(memory.id)!
      const scope = memory.scope === input.scope ? 1.25 : 1
      return {
        memory,
        reasons: entry.reasons,
        score:
          (entry.score + (supported.has(memory.id) ? 0.002 : 0)) *
          scope *
          (0.95 + 0.05 * freshness(memory, input.now)),
      }
    })
    .sort((a, b) => b.score - a.score || b.memory.observedAt - a.memory.observedAt)
  const selected = hits.slice(0, Math.min(20, Math.max(0, input.limit)))
  const shown = new Set(selected.map((item) => item.memory.id))
  const strong = new Set([...exact, ...lexical])
  const entities = new Map(
    referencedEntities(ctx, [
      ...selected.map((item) => item.memory),
      ...memoryCards(ctx, routes.memories),
    ]).map((item) => [item.id, item]),
  )
  for (const id of focus) entities.set(id, entity(ctx, id)!)
  return {
    status: selected.length ? 'ok' : 'no_match',
    hits: selected,
    entities: [...entities.values()],
    focus,
    paths: routes.paths,
    more: Math.min(50, [...strong].filter((id) => !shown.has(id)).length),
    branch: input.branch,
    degradation,
  }
}
