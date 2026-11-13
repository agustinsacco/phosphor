import type { BrainEntity } from '@phosphor/shared/brain'
import { entityMatches, STOPWORDS, wordRows } from './candidates'
import { all, one, type Context } from './database'
import { entity, entityNumber } from './entities'
import { tokens, wholePhrase } from './text'

const trimEdges = (text: string): string =>
  text.trim().replace(/^[\s"'“”‘’`([{]+|[\s"'“”‘’`)\]}.,;:!?]+$/gu, '')
export function named(items: BrainEntity[], query: string): BrainEntity[] {
  if (tokens(query).every((word) => STOPWORDS.has(word))) return []
  const phrase = trimEdges(query)
  return items.filter((item) =>
    [item.label, ...item.aliases].some(
      (name) => wholePhrase(query, name) || wholePhrase(name, phrase),
    ),
  )
}
export function entitySeeds(ctx: Context, query: string, limit: number): string[] {
  const probes = [query, ...tokens(query).filter((word) => !STOPWORDS.has(word))].slice(0, 33)
  const ids = new Set(
    entityMatches(
      ctx,
      probes.map((label) => ({ label, aliases: [], keys: [] })),
      limit,
    )
      .flat()
      .map((item) => item.entityId),
  )
  // Namespace keys remain queryable without parsing caller text as SQL or FTS syntax.
  for (const token of query.split(/\s+/u).slice(0, 32))
    for (const row of all<{ id: string }>(
      ctx,
      'SELECT e.id FROM entity_keys k JOIN entities e ON e.n=k.entity WHERE k.namespace=? AND k.value=? LIMIT ?',
      ...splitKey(token),
      limit,
    ))
      ids.add(row.id)
  return [...ids].slice(0, 200)
}
function splitKey(token: string): [string, string] {
  const separator = token.lastIndexOf(':')
  return [token.slice(0, separator), token.slice(separator + 1)]
}
export function lexicalIds(ctx: Context, query: string, limit = 50): string[] {
  return wordRows(ctx, 'memory_words', query, limit).flatMap((row) => {
    const memory = one<{ id: string }>(
      ctx,
      "SELECT id FROM memories WHERE n=? AND state IN ('active','disputed')",
      row.rowid,
    )
    return memory ? [memory.id] : []
  })
}
export function about(ctx: Context, ids: string[], limit = 50): string[] {
  const result = new Set<string>()
  for (const id of ids.slice(0, 200)) {
    for (const row of all<{ id: string }>(
      ctx,
      "SELECT m.id FROM mentions a JOIN memories m ON m.n=a.memory WHERE a.entity=? AND m.state IN ('active','disputed') ORDER BY m.observed_at DESC LIMIT ?",
      entityNumber(ctx, id),
      limit,
    ))
      result.add(row.id)
    if (result.size >= 400) break
  }
  return [...result].slice(0, 400)
}
export function seedEntities(ctx: Context, ids: string[]): BrainEntity[] {
  return ids.flatMap((id) => {
    const found = entity(ctx, id)
    return found ? [found] : []
  })
}
