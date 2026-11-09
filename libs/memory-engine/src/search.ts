import type {
  BrainEntity,
  BrainHit,
  BrainMemory,
  BrainMemoryType,
  BrainRecall,
} from '@phosphor/shared/brain'
import { all, type Context } from './database'
import { entities, fold, referencedEntities, tokens, wholePhrase } from './entities'
import { activeMemories } from './knowledge'
import type { SearchInput } from './types'
import { cosine, decodeVector } from './vectors'

const stopwords = new Set(
  (
    'a an the is it to of in on for and or what who how why do does did can be by with ' +
    'about my me i we you that this as at from there their our know tell'
  ).split(' '),
)
export function lexicalIds(ctx: Context, query: string): string[] {
  const words = [...new Set(tokens(query).filter((word) => !stopwords.has(word)))]
  if (!words.length) return []
  const match = words.map((word) => `"${word}"`).join(' OR ')
  return all<{ id: string }>(
    ctx,
    'SELECT id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts), rowid LIMIT 50',
    match,
  ).map((row) => row.id)
}
function semanticIds(ctx: Context, vector: Float32Array): string[] {
  return all<{ memory_id: string; vector: Uint8Array }>(
    ctx,
    "SELECT v.* FROM vectors v JOIN memories m ON m.id=v.memory_id WHERE m.state='active'",
  )
    .map((row) => ({ id: row.memory_id, score: cosine(vector, decodeVector(row.vector)) }))
    .filter((row) => row.score >= 0.35)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((row) => row.id)
}
function exactIds(items: BrainEntity[], memories: BrainMemory[], query: string): string[] {
  const ids = new Set(
    items
      .filter((item) => [item.label, ...item.aliases].some((name) => wholePhrase(query, name)))
      .map((item) => item.id),
  )
  return memories
    .filter((item) => ids.has(item.subjectId) || (item.objectId && ids.has(item.objectId)))
    .map((item) => item.id)
}
function recall(ctx: Context, hits: BrainHit[], degradation: string[] = []): BrainRecall {
  return {
    status: hits.length ? 'ok' : 'no_match',
    hits,
    entities: referencedEntities(
      ctx,
      hits.map((hit) => hit.memory),
    ),
    degradation,
  }
}
/**
 * Days until a memory ranks at three quarters of its weight. Open questions and risks
 * go stale first; how things are done lasts longest. Age only reorders: it never
 * drops below half, so an old memory is still found when nothing newer matches.
 */
const HALF_LIFE_DAYS: Record<BrainMemoryType, number> = {
  open: 30,
  risk: 60,
  decision: 180,
  fact: 180,
  procedure: 365,
  preference: 365,
}
export function freshness(memory: BrainMemory, now: number): number {
  const days = Math.max(0, now - memory.observedAt) / 86_400_000
  return 0.5 + 0.5 * 2 ** (-days / HALF_LIFE_DAYS[memory.type])
}
function boundedLimit(limit: number | undefined, fallback: number): number {
  return Number.isFinite(limit) ? Math.min(20, Math.max(0, Math.floor(limit!))) : fallback
}
export function search(ctx: Context, input: SearchInput): BrainRecall {
  const memories = activeMemories(ctx)
  const scores = new Map<string, { score: number; reasons: BrainHit['reasons'] }>()
  const ranks: { ids: string[]; reason: BrainHit['reasons'][number]; weight: number }[] = [
    {
      ids: input.vector === null ? [] : semanticIds(ctx, input.vector),
      reason: 'semantic',
      weight: 2,
    },
    { ids: lexicalIds(ctx, input.query), reason: 'lexical', weight: 1 },
    { ids: exactIds(entities(ctx), memories, input.query), reason: 'exact', weight: 1 },
  ]
  for (const { ids, reason, weight } of ranks) {
    ids.forEach((id, index) => {
      const entry = scores.get(id) ?? { score: 0, reasons: [] }
      entry.score += weight / (60 + index + 1)
      entry.reasons.push(reason)
      scores.set(id, entry)
    })
  }
  const now = ctx.now()
  const hits = memories
    .flatMap((memory): BrainHit[] => {
      const entry = scores.get(memory.id)
      const scope = memory.scope === input.scope ? 1.25 : 1
      return entry
        ? [{ memory, ...entry, score: entry.score * scope * freshness(memory, now) }]
        : []
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, boundedLimit(input.limit, 6))
  return recall(ctx, hits, input.vector === null ? ['semantic search unavailable'] : [])
}
/** Small global entity sets do not need another FTS index for name fallback. */
function resolveRelated(items: BrainEntity[], query: string): BrainEntity | undefined {
  const exact =
    items.find((item) => item.id === query) ??
    items.find((item) => [item.label, ...item.aliases].some((name) => fold(name) === fold(query)))
  if (exact) return exact
  const words = new Set(tokens(query))
  const ranked = items
    .map((item) => ({
      item,
      score: Math.max(
        ...[item.label, ...item.aliases].map((name) => {
          const shared = tokens(name).filter((word) => words.has(word)).length
          if (!shared) return 0
          const contains = fold(name).includes(fold(query)) || fold(query).includes(fold(name))
          return shared + (contains ? 1000 : 0)
        }),
      ),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
  return ranked[0]?.item
}
export function related(
  ctx: Context,
  query: string,
  limit = 12,
  scope: string | null,
): BrainRecall {
  const found = resolveRelated(entities(ctx), query)
  if (!found) return recall(ctx, [])
  const memories = activeMemories(ctx)
    .filter((item) => item.subjectId === found.id || item.objectId === found.id)
    .sort((a, b) => Number(b.scope === scope) - Number(a.scope === scope))
    .slice(0, Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 12)
  const result = recall(
    ctx,
    memories.map((memory, index) => ({ memory, score: 1 / (61 + index), reasons: ['exact'] })),
  )
  if (!result.entities.some((item) => item.id === found.id)) result.entities.unshift(found)
  return result
}
