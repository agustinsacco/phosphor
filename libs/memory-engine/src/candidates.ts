import type { BrainEntityKind, BrainPredicate } from '@phosphor/shared/brain'
import { all, one, type Context } from './database'
import { entity, entityNumber } from './entities'
import { memoryCards } from './knowledge'
import { fold, tokens } from './text'
import type { ClaimProbe, EntityCard, EntityMatch, ProposalEntity } from './types'

export const STOPWORDS = new Set(
  'a an the is it to of in on for and or what who how why do does did can be by with about my me i we you that this as at from there their our know tell'.split(
    ' ',
  ),
)
function terms(query: string): string[] {
  return [...new Set(tokens(query).filter((word) => !STOPWORDS.has(word)))].slice(0, 32)
}
/** Quoting every token prevents user text from becoming FTS syntax. AND first, rare OR fallback. */
export function wordRows(
  ctx: Context,
  table: 'memory_words' | 'entity_words',
  query: string,
  limit: number,
): { rowid: number; score: number }[] {
  const words = terms(query)
  if (!words.length || limit <= 0) return []
  const quoted = (word: string): string => `"${word.replaceAll('"', '""')}"`
  const search = (expression: string, cap: number) =>
    all<{ rowid: number; score: number }>(
      ctx,
      `SELECT rowid,bm25(${table}) AS score FROM ${table} WHERE ${table} MATCH ? ORDER BY score LIMIT ?`,
      expression,
      cap,
    )
  const result = search(words.map(quoted).join(' AND '), limit)
  if (result.length >= limit) return result
  // FTS dictionary lookups provide exact document frequencies without scanning postings.
  const rare = words
    .map((word) => ({
      word,
      count:
        one<{ doc: number }>(ctx, `SELECT doc FROM ${table}_vocab WHERE term=?`, word)?.doc ?? 0,
    }))
    .sort((a, b) => a.count - b.count)
    .slice(0, 6)
  const seen = new Set(result.map((row) => row.rowid))
  for (const row of search(rare.map(({ word }) => quoted(word)).join(' OR '), limit))
    if (!seen.has(row.rowid)) {
      result.push(row)
      seen.add(row.rowid)
    }
  return result.slice(0, limit)
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
      if (fold(name).length >= 3)
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
export function neighbours(
  ctx: Context,
  ids: string[],
  kinds: BrainEntityKind[] | null,
  limit: number,
) {
  return ids
    .flatMap((id) => {
      const n = entityNumber(ctx, id)
      return (['out', 'in'] as const).flatMap((direction) => {
        const own = direction === 'out' ? 'subject' : 'object'
        const other = direction === 'out' ? 'object' : 'subject'
        return all<{
          id: string
          predicate: BrainPredicate
        }>(
          ctx,
          `SELECT e.id,r.predicate FROM relations r JOIN entities e ON e.n=r.${other} WHERE r.${own}=? AND r.live=1 ${kinds?.length ? `AND e.kind IN (${kinds.map(() => '?').join(',')})` : ''} ORDER BY r.observed_at DESC LIMIT ?`,
          n,
          ...(kinds ?? []),
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
      ? [{ ...item, neighbours: neighbours(ctx, [id], null, 3).map((row) => row.neighbour.label) }]
      : []
  })
}
/** A job's new entities are refs, not rows: they match nothing, never throw. */
function knownNumber(ctx: Context, id: string): number | undefined {
  return one<{ n: number }>(ctx, 'SELECT n FROM entities WHERE id=?', id)?.n
}
export function memoryMatches(ctx: Context, probes: ClaimProbe[], limit: number): string[][] {
  return probes.map((probe) => {
    const found = new Set<string>()
    const add = (rows: { id: string }[]) => rows.forEach((row) => found.add(row.id))
    for (const link of probe.links) {
      const subject = knownNumber(ctx, link.subjectId)
      const object = knownNumber(ctx, link.objectId)
      if (subject !== undefined && object !== undefined)
        add(
          all(
            ctx,
            `SELECT m.id FROM relations r JOIN memories m ON m.n=r.memory WHERE r.subject=? AND r.live=1 AND r.predicate=? AND r.object=? ORDER BY r.observed_at DESC LIMIT ?`,
            subject,
            link.predicate,
            object,
            limit,
          ),
        )
      // A new owner of an existing thing may replace its old owner.
      if (link.predicate === 'owns' && object !== undefined)
        add(
          all(
            ctx,
            `SELECT m.id FROM relations r JOIN memories m ON m.n=r.memory WHERE r.object=? AND r.live=1 AND r.predicate='owns' ORDER BY r.observed_at DESC LIMIT ?`,
            object,
            limit,
          ),
        )
    }
    for (const id of probe.entityIds) {
      const n = knownNumber(ctx, id)
      if (n !== undefined)
        add(
          all(
            ctx,
            `SELECT m.id FROM mentions a JOIN memories m ON m.n=a.memory WHERE a.entity=? AND m.state IN ('active','disputed') ORDER BY m.observed_at DESC LIMIT ?`,
            n,
            limit,
          ),
        )
    }
    return [...found].slice(0, limit)
  })
}
export { memoryCards }
