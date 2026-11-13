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
  const probes = [
    ...new Set([query, ...tokens(query).filter((word) => !STOPWORDS.has(word))]),
  ].slice(0, 33)
  const keys = query
    .split(/\s+/u)
    .slice(0, 32)
    .filter((token) => token.includes(':'))
    .map((token) => {
      const separator = token.lastIndexOf(':')
      return { namespace: token.slice(0, separator), value: token.slice(separator + 1) }
    })
  const priority = { key: 0, name: 1, words: 2, trigram: 3 }
  const matches = entityMatches(
    ctx,
    probes.map((label, index) => ({
      label,
      aliases: [],
      keys: index === 0 ? keys : [],
    })),
    limit,
  )
    .flat()
    .sort((a, b) => priority[a.channel] - priority[b.channel])
  return [...new Set(matches.map((item) => item.entityId))].slice(0, 200)
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
