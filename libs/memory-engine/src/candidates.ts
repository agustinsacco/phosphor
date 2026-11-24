import type { BrainPredicate } from '@phosphor/shared/brain'
import { all, one, type Context } from './database'
import { entity, entityNumber, survivingEntityId } from './entities'
import { memoryCards } from './knowledge'
import { fold, tokens } from './text'
import type { ClaimProbe, EntityCard, EntityMatch, MemoryMatch, ProposalEntity } from './types'
import { cosine, decodeVector } from './vectors'

export const STOPWORDS = new Set(
  'a an the is it to of in on for and or what who how why do does did can be by with about my me i we you that this as at from there their our know tell'.split(
    ' ',
  ),
)
function terms(query: string): string[] {
  return [...new Set(tokens(query).filter((word) => !STOPWORDS.has(word)))].slice(0, 32)
}
/** Above 1% (with a 5k floor), a term is context, not a selective ranked-scan driver. */
function commonnessCap(ctx: Context, table: 'memory_words' | 'entity_words'): number {
  const count = Number(
    one<{ value: string }>(
      ctx,
      'SELECT value FROM meta WHERE key=?',
      table === 'memory_words' ? 'memories' : 'entities',
    )?.value ?? 0,
  )
  return Math.max(5000, Math.floor(count * 0.01))
}
/** Quoted tokens cannot become FTS syntax. Only a rare term may drive a ranked scan. */
export function wordRows(
  ctx: Context,
  table: 'memory_words' | 'entity_words',
  query: string,
  limit: number,
): { rowid: number; score: number }[] {
  const words = terms(query)
  if (!words.length || limit <= 0) return []
  const cap = commonnessCap(ctx, table)
  // Dictionary lookups read document counts, not the potentially million-row postings.
  const rare = words
    .map((word) => ({
      word,
      count:
        one<{ doc: number }>(ctx, `SELECT doc FROM ${table}_vocab WHERE term=?`, word)?.doc ?? 0,
    }))
    .filter(({ count }) => count <= cap)
    .sort((a, b) => a.count - b.count)
  const quoted = (word: string): string => `"${word.replaceAll('"', '""')}"`
  if (!rare.length)
    return all(
      ctx,
      `SELECT rowid,0 AS score FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid DESC LIMIT ?`,
      words.map(quoted).join(' AND '),
      limit,
    )
  const common = words.filter((word) => !rare.some((term) => term.word === word))
  const textColumn = table === 'memory_words' ? 'summary' : 'text'
  const search = (expression: string, cap: number) =>
    all<{ rowid: number; score: number; text: string }>(
      ctx,
      `SELECT rowid,bm25(${table}) AS score,${textColumn} AS text FROM ${table} WHERE ${table} MATCH ? ORDER BY score LIMIT ?`,
      expression,
      Math.min(400, cap * 4),
    )
      .map(({ rowid, score, text }) => {
        const present = new Set(tokens(text))
        return { rowid, score, common: common.filter((word) => present.has(word)).length }
      })
      .sort((a, b) => b.common - a.common || a.score - b.score)
      .slice(0, cap)
      .map(({ rowid, score }) => ({ rowid, score }))
  const result = search(rare.map(({ word }) => quoted(word)).join(' AND '), limit)
  if (result.length >= limit) return result
  const seen = new Set(result.map((row) => row.rowid))
  for (const row of search(
    rare
      .slice(0, 6)
      .map(({ word }) => quoted(word))
      .join(' OR '),
    limit,
  ))
    if (!seen.has(row.rowid)) {
      result.push(row)
      seen.add(row.rowid)
    }
  return result.slice(0, limit)
}
function usefulTrigram(ctx: Context, name: string): boolean {
  if (fold(name).length < 3) return false
  const cap = commonnessCap(ctx, 'entity_words')
  const count = one<{ count: number }>(
    ctx,
    'SELECT COUNT(*) AS count FROM (SELECT rowid FROM entity_grams WHERE entity_grams MATCH ? LIMIT ?)',
    `"${fold(name).replaceAll('"', '""')}"`,
    cap + 1,
  )!.count
  return count > 0 && count <= cap
}
export function entityMatches(
  ctx: Context,
  probes: Pick<ProposalEntity, 'label' | 'aliases' | 'keys'>[],
  limit: number,
): EntityMatch[][] {
  const cap = Math.min(100, Math.max(0, limit))
  return probes.map((probe) => {
    const result: EntityMatch[] = []
    const add = (rows: { id: string; score?: number }[], channel: EntityMatch['channel']) => {
      for (const row of rows)
        if (!result.some((item) => item.entityId === row.id && item.channel === channel))
          result.push({ entityId: row.id, channel, score: row.score ?? 1 })
    }
    for (const key of probe.keys)
      add(
        all(
          ctx,
          'SELECT e.id FROM entity_keys k JOIN entities e ON e.n=k.entity WHERE k.namespace=? AND k.value=? LIMIT ?',
          key.namespace,
          key.value,
          cap,
        ),
        'key',
      )
    for (const name of [probe.label, ...probe.aliases]) {
      add(
        all(
          ctx,
          'SELECT e.id FROM entity_names a JOIN entities e ON e.n=a.entity WHERE a.folded=? LIMIT ?',
          fold(name),
          cap,
        ),
        'name',
      )
      add(
        wordRows(ctx, 'entity_words', name, cap).map((row) => ({
          id: one<{ id: string }>(ctx, 'SELECT id FROM entities WHERE n=?', row.rowid)!.id,
          score: -row.score,
        })),
        'words',
      )
      if (usefulTrigram(ctx, name))
        add(
          all(
            ctx,
            `SELECT DISTINCT e.id,bm25(entity_grams) AS score FROM entity_grams JOIN entity_names a ON a.n=entity_grams.rowid JOIN entities e ON e.n=a.entity WHERE entity_grams MATCH ? ORDER BY score LIMIT ?`,
            `"${fold(name).replaceAll('"', '""')}"`,
            cap,
          ),
          'trigram',
        )
    }
    // Each channel has its own cap, not a global cap that would hide lexical candidates.
    return result.filter(
      (item, index) =>
        result.slice(0, index).filter((old) => old.channel === item.channel).length < cap,
    )
  })
}
function neighbours(ctx: Context, ids: string[], limit: number) {
  return ids
    .flatMap((id) => {
      const n = entityNumber(ctx, survivingEntityId(ctx, id))
      return (['out', 'in'] as const).flatMap((direction) => {
        const own = direction === 'out' ? 'subject' : 'object'
        const other = direction === 'out' ? 'object' : 'subject'
        return all<{
          id: string
          predicate: BrainPredicate
        }>(
          ctx,
          `SELECT e.id,r.predicate FROM relations r JOIN entities e ON e.n=r.${other} WHERE r.${own}=? AND r.live=1 ORDER BY r.observed_at DESC LIMIT ?`,
          n,
          limit,
        ).map((row) => ({
          entityId: id,
          neighbour: entity(ctx, row.id)!,
          predicate: row.predicate,
          direction,
        }))
      })
    })
    .slice(0, limit)
}
export function entityCards(ctx: Context, ids: string[]): EntityCard[] {
  return ids.flatMap((id) => {
    const item = entity(ctx, id)
    return item
      ? [{ ...item, neighbours: neighbours(ctx, [id], 3).map((row) => row.neighbour.label) }]
      : []
  })
}
/** A job's new entities are refs, not rows: they match nothing, never throw. */
function knownNumber(ctx: Context, id: string): number | undefined {
  return one<{ n: number }>(ctx, 'SELECT n FROM entities WHERE id=?', id)?.n
}
/** How many of an entity's newest memories a claim about it is compared with. */
const ENTITY_WINDOW = 128
/** A superseded memory this close to a claim is offered as replaced earlier. */
const REPLACED_SIMILARITY = 0.85
interface StoredMemory {
  id: string
  state: string
  vector: Uint8Array | null
}
const STORED = 'm.id,m.state,v.vector'
const VECTOR = 'LEFT JOIN memory_vectors v ON v.memory=m.n'
/** One entity's window scored against every claim naming it. Its vectors are not kept. */
interface ScoredWindow {
  ids: string[]
  current: boolean[]
  /** By probe index: each row's cosine to that probe, in window order; 0 without vectors. */
  scores: Map<number, Float64Array>
}
/**
 * Loads each named entity's window once, scores it against all claims naming it, and drops its
 * vectors before the next one, so a read naming hundreds of entities holds one window's
 * vectors at a time (about 384 KiB) instead of all of them.
 */
function scoredWindows(
  ctx: Context,
  probes: ClaimProbe[],
  numbers: Map<string, number | undefined>,
): Map<number, ScoredWindow> {
  const naming = new Map<number, Set<number>>()
  probes.forEach((probe, index) => {
    for (const id of probe.entityIds) {
      if (!numbers.has(id)) numbers.set(id, knownNumber(ctx, id))
      const n = numbers.get(id)
      if (n !== undefined) naming.set(n, (naming.get(n) ?? new Set()).add(index))
    }
  })
  const windows = new Map<number, ScoredWindow>()
  for (const [n, named] of naming) {
    const rows = all<StoredMemory>(
      ctx,
      `SELECT ${STORED} FROM mentions a JOIN memories m ON m.n=a.memory ${VECTOR} WHERE a.entity=? ORDER BY a.memory DESC LIMIT ?`,
      n,
      ENTITY_WINDOW,
    )
    const scores = new Map([...named].map((index) => [index, new Float64Array(rows.length)]))
    rows.forEach((row, i) => {
      if (!row.vector) return
      const vector = decodeVector(row.vector)
      for (const index of named) {
        const probe = probes[index]!.vector
        if (probe) scores.get(index)![i] = cosine(probe, vector)
      }
    })
    windows.set(n, {
      ids: rows.map((row) => row.id),
      current: rows.map((row) => CURRENT.has(row.state)),
      scores,
    })
  }
  return windows
}
/**
 * Memories that may say the same thing as each claim: those stating one of its links, and the
 * entity matches most similar to it among each named entity's newest memories, so a busy
 * person's recent unrelated memories cannot hide a close one. Superseded memories in those
 * windows come back only when very close. At most `limit` per channel.
 */
export function memoryMatches(ctx: Context, probes: ClaimProbe[], limit: number): MemoryMatch[][] {
  const numbers = new Map<string, number | undefined>()
  const windows = scoredWindows(ctx, probes, numbers)
  return probes.map((probe, index) => {
    const score = (row: StoredMemory): number =>
      probe.vector && row.vector ? cosine(probe.vector, decodeVector(row.vector)) : 0
    const linked = new Map<string, MemoryMatch>()
    for (const row of linkMatches(ctx, probe, limit))
      if (!linked.has(row.id))
        linked.set(row.id, { id: row.id, channel: 'link', similarity: score(row) })
    const named = new Map<string, MemoryMatch>()
    for (const id of probe.entityIds) {
      const n = numbers.get(id)
      if (n === undefined) continue
      const window = windows.get(n)!
      const scores = window.scores.get(index)!
      window.ids.forEach((memoryId, i) => {
        if (linked.has(memoryId) || named.has(memoryId)) return
        const similarity = scores[i]!
        if (window.current[i]) named.set(memoryId, { id: memoryId, channel: 'entity', similarity })
        else if (similarity >= REPLACED_SIMILARITY)
          named.set(memoryId, { id: memoryId, channel: 'replaced', similarity })
      })
    }
    // A stable sort keeps the newest first among equally similar memories.
    const ranked = [...named.values()].sort((a, b) => b.similarity - a.similarity)
    return [
      ...[...linked.values()].slice(0, limit),
      ...ranked.filter((m) => m.channel === 'entity').slice(0, limit),
      ...ranked.filter((m) => m.channel === 'replaced').slice(0, limit),
    ]
  })
}
const CURRENT = new Set(['active', 'disputed'])
/** Current links only; equality is subject, predicate and object, never the wording. */
function linkMatches(ctx: Context, probe: ClaimProbe, limit: number): StoredMemory[] {
  const rows: StoredMemory[] = []
  for (const link of probe.links) {
    const subject = knownNumber(ctx, link.subjectId)
    const object = knownNumber(ctx, link.objectId)
    if (subject !== undefined && object !== undefined)
      rows.push(
        ...all<StoredMemory>(
          ctx,
          `SELECT ${STORED} FROM relations r JOIN memories m ON m.n=r.memory ${VECTOR} WHERE r.subject=? AND r.live=1 AND (r.valid_to IS NULL OR r.valid_to>?) AND r.predicate=? AND r.object=? ORDER BY r.observed_at DESC LIMIT ?`,
          subject,
          ctx.now(),
          link.predicate,
          object,
          limit,
        ),
      )
    // A new owner of an existing thing may replace its old owner.
    if (link.predicate === 'owns' && object !== undefined)
      rows.push(
        ...all<StoredMemory>(
          ctx,
          `SELECT ${STORED} FROM relations r JOIN memories m ON m.n=r.memory ${VECTOR} WHERE r.object=? AND r.live=1 AND (r.valid_to IS NULL OR r.valid_to>?) AND r.predicate='owns' ORDER BY r.observed_at DESC LIMIT ?`,
          object,
          ctx.now(),
          limit,
        ),
      )
  }
  return rows
}
export { memoryCards }
