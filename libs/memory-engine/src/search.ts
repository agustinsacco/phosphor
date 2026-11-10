import type {
  BrainEntity,
  BrainHit,
  BrainLink,
  BrainMemory,
  BrainMemoryType,
  BrainRecall,
} from '@phosphor/shared/brain'
import { all, type Context } from './database'
import { entities, tokens, wholePhrase } from './entities'
import { activeMemories } from './knowledge'
import type { SearchInput } from './types'
import { cosine, decodeVector } from './vectors'

const stopwords = new Set(
  (
    'a an the is it to of in on for and or what who how why do does did can be by with ' +
    'about my me i we you that this as at from there their our know tell'
  ).split(' '),
)
/** Ranking reads the best 50; counting what was left out passes -1, no cap. */
export function lexicalIds(ctx: Context, query: string, limit = 50): string[] {
  const words = [...new Set(tokens(query).filter((word) => !stopwords.has(word)))]
  if (!words.length) return []
  const match = words.map((word) => `"${word}"`).join(' OR ')
  return all<{ id: string }>(
    ctx,
    'SELECT id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts), rowid LIMIT ?',
    match,
    limit,
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
  const effective = memory.validFrom !== null && memory.validFrom <= now ? memory.validFrom : 0
  const days = Math.max(0, now - Math.max(memory.observedAt, effective)) / 86_400_000
  return 0.5 + 0.5 * 2 ** (-days / HALF_LIFE_DAYS[memory.type])
}
function boundedLimit(limit: number | undefined, fallback: number): number {
  return Number.isFinite(limit) ? Math.min(20, Math.max(0, Math.floor(limit!))) : fallback
}
/** Quotes, brackets and sentence marks around a query; never + or # inside a name. */
const trimEdges = (text: string): string =>
  text.trim().replace(/^[\s"'“”‘’`([{]+|[\s"'“”‘’`)\]}.,;:!?]+$/gu, '')
/**
 * Entities the query names, or that hold the whole query in their name: "Rina" names
 * Rina Okafor, and "NRS" names every NRS project. Whole words only, never substrings.
 */
function named(items: BrainEntity[], query: string): BrainEntity[] {
  if (tokens(query).every((word) => stopwords.has(word))) return []
  const phrase = trimEdges(query)
  return items.filter((item) =>
    [item.label, ...item.aliases].some(
      (name) => wholePhrase(query, name) || wholePhrase(name, phrase),
    ),
  )
}
function about(memories: BrainMemory[], ids: Set<string>): string[] {
  return memories
    .filter((item) => ids.has(item.subjectId) || (item.objectId !== null && ids.has(item.objectId)))
    .map((item) => item.id)
}
const MAX_LINKS = 8
/** The graph one hop out: links that touch a named entity, and who is at the other end. */
function hop(memories: BrainMemory[], focus: Set<string>) {
  const links = new Map<string, BrainLink>()
  for (const { subjectId, predicate, objectId } of memories) {
    if (objectId === null || (!focus.has(subjectId) && !focus.has(objectId))) continue
    links.set(`${subjectId} ${predicate} ${objectId}`, { subjectId, predicate, objectId })
  }
  const all = [...links.values()]
  const ends = all.flatMap((link) => [link.subjectId, link.objectId])
  return {
    links: all.slice(0, MAX_LINKS),
    neighbours: new Set(ends.filter((id) => !focus.has(id))),
  }
}
type Ranking = { ids: string[]; reason: BrainHit['reasons'][number]; weight: number }
/** Reciprocal-rank fusion: each list adds weight / (60 + rank). */
function fuse(ranks: Ranking[]): Map<string, { score: number; reasons: BrainHit['reasons'] }> {
  const scores = new Map<string, { score: number; reasons: BrainHit['reasons'] }>()
  for (const { ids, reason, weight } of ranks) {
    ids.forEach((id, index) => {
      const entry = scores.get(id) ?? { score: 0, reasons: [] }
      entry.score += weight / (60 + index + 1)
      entry.reasons.push(reason)
      scores.set(id, entry)
    })
  }
  return scores
}
/**
 * One call answers what a lane agent asks: memories that match, about the entities the
 * query names, and about whatever those link to (at half weight, so they rank below).
 */
export function search(ctx: Context, input: SearchInput): BrainRecall {
  const memories = activeMemories(ctx)
  const known = entities(ctx)
  const focus = named(known, input.query)
  const focusIds = new Set(focus.map((item) => item.id))
  const exact = about(memories, focusIds)
  const lexical = lexicalIds(ctx, input.query)
  const strong = new Set([...exact, ...lexicalIds(ctx, input.query, -1)])
  const { links, neighbours } = hop(memories, focusIds)
  const linked = about(memories, neighbours).filter((id) => !exact.includes(id))
  const scores = fuse([
    {
      ids: input.vector === null ? [] : semanticIds(ctx, input.vector),
      reason: 'semantic',
      weight: 2,
    },
    { ids: lexical, reason: 'lexical', weight: 1 },
    { ids: exact, reason: 'exact', weight: 1 },
    { ids: linked, reason: 'linked', weight: 0.5 },
  ])
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
    .slice(0, boundedLimit(input.limit, 8))
  const shown = new Set(hits.map((hit) => hit.memory.id))
  const referenced = new Set([
    ...focusIds,
    ...links.flatMap((link) => [link.subjectId, link.objectId]),
    ...hits.flatMap(({ memory }) => [memory.subjectId, memory.objectId]),
  ])
  return {
    status: hits.length ? 'ok' : 'no_match',
    hits,
    entities: known.filter((item) => referenced.has(item.id)),
    focus: [...focusIds],
    links,
    more: memories.filter((item) => strong.has(item.id) && !shown.has(item.id)).length,
    degradation: input.vector === null ? ['semantic search unavailable'] : [],
  }
}
