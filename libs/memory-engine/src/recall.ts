import type { BrainMemory, BrainMemoryType } from '@phosphor/shared/brain'
import { referencedEntities } from './entities'
import { memoryCards } from './knowledge'
import { about, matchedSeeds, lexicalIds, named, seedEntities } from './seeds'
import { ppr, type Seeds } from './ppr'
import { RECALL_TUNING } from './recall-tuning'
export { RECALL_TUNING } from './recall-tuning'
import type { BrainHit, BrainRecall, BrainTrail } from '@phosphor/shared/brain-recall'
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
export interface Nearest {
  entities: Neighbour[]
  memories: Neighbour[]
}
/** How many neighbours of the query vector the ranking reads; `brain:find` reads the same. */
export const NEAREST = { entities: 20, memories: 50 }
interface Ranking {
  /** Every current memory a route reached, best first. */
  hits: BrainHit[]
  focus: string[]

  strong: Set<string>
}
/**
 * The hybrid ranking behind `brain_search` and the Brain page's search: semantic, word, named
 * and linked routes fused by reciprocal rank, then scope and freshness.
 */
export function rank(
  ctx: Context,
  input: SearchInput,
  nearest: Nearest,
  tuning = RECALL_TUNING,
): Ranking {
  const { candidates, keys } = matchedSeeds(ctx, input.query, 20)
  const focus = [
    ...new Set([
      ...keys,
      ...named(seedEntities(ctx, candidates), input.query).map((item) => item.id),
    ]),
  ]
  const semantic = nearest.memories.filter((item) => item.score >= tuning.minCosine)
  const lexical = lexicalIds(ctx, input.query)
  const seeds: Seeds = { focus: new Set(focus), entities: new Map(), memories: new Map() }
  for (const hit of nearest.entities)
    if (hit.score >= tuning.minCosine)
      seeds.entities.set(hit.id, tuning.entityVectorSeed * hit.score)
  for (const id of candidates) seeds.entities.set(id, tuning.candidateSeed)
  for (const id of focus) seeds.entities.set(id, tuning.focusSeed)
  for (const id of lexical) seeds.memories.set(id, tuning.lexicalSeed)
  for (const hit of semantic)
    seeds.memories.set(hit.id, (seeds.memories.get(hit.id) ?? 0) + hit.score)
  const exact = about(ctx, focus)
  const linked = ppr(ctx, seeds, input.now, tuning)
  const ranks: { ids: string[]; reason: BrainHit['reasons'][number]; weight: number }[] = [
    { ids: semantic.map((hit) => hit.id), reason: 'semantic', weight: tuning.semantic },
    { ids: lexical, reason: 'lexical', weight: tuning.lexical },
    { ids: exact, reason: 'exact', weight: tuning.exact },
    { ids: linked.memories, reason: 'linked', weight: tuning.linked },
  ]
  const scores = new Map<string, { score: number; reasons: BrainHit['reasons'] }>()
  for (const rank of ranks)
    rank.ids.forEach((id, index) => {
      const old = scores.get(id) ?? { score: 0, reasons: [] }
      old.score += rank.weight / (1 + tuning.rrf + index)
      if (!old.reasons.includes(rank.reason)) old.reasons.push(rank.reason)
      scores.set(id, old)
    })
  const hits = rankedHits(ctx, input, scores, linked.trails, tuning)
  return { hits, focus, strong: new Set([...exact, ...lexical]) }
}
export function recall(
  ctx: Context,
  input: SearchInput,
  nearest: Nearest,
  degradation: string[],
  tuning = RECALL_TUNING,
): BrainRecall {
  const { hits, focus, strong } = rank(ctx, input, nearest, tuning)
  const selected = hits.slice(0, Math.min(20, Math.max(0, input.limit)))
  const shown = new Set(selected.map((item) => item.memory.id))
  const ids = new Set(focus)
  for (const { trail } of selected)
    if (trail) {
      ids.add(trail.seedId)
      ids.add(trail.entityId)
      for (const link of trail.links) {
        ids.add(link.subjectId)
        ids.add(link.objectId)
      }
    }
  const entities = referencedEntities(ctx, [
    ...selected.map((h) => h.memory),
    { entityIds: [...ids] },
  ])
  return {
    mode: 'search',
    status: selected.length ? 'ok' : 'no_match',
    hits: selected,
    entities,
    focus,
    more: Math.min(50, [...strong].filter((id) => !shown.has(id)).length),
    branch: input.branch,
    degradation,
  }
}

function rankedHits(
  ctx: Context,
  input: SearchInput,
  scores: Map<string, { score: number; reasons: BrainHit['reasons'] }>,
  trails: Map<string, BrainTrail>,
  tuning: typeof RECALL_TUNING,
): BrainHit[] {
  return memoryCards(ctx, [...scores.keys()])
    .filter((memory) => memory.state !== 'superseded')
    .map((memory) => {
      const entry = scores.get(memory.id)!
      const scope = memory.scope === input.scope ? tuning.scope : 1
      return {
        memory,
        reasons: entry.reasons,
        trail: trails.get(memory.id) ?? null,
        score:
          entry.score *
          (memory.importance === 2
            ? tuning.important
            : memory.importance === 0
              ? tuning.unimportant
              : 1) *
          (memory.validTo !== null && memory.validTo <= input.now ? tuning.expired : 1) *
          scope *
          (1 - tuning.freshness + tuning.freshness * freshness(memory, input.now)),
      }
    })
    .sort((a, b) => b.score - a.score || b.memory.observedAt - a.memory.observedAt)
}
