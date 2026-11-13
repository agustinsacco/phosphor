import {
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  type BrainConnection,
  type BrainConnectionPage,
  type BrainEntityView,
  type BrainMemoryFilter,
  type BrainMemoryPage,
  type BrainPredicate,
} from '@phosphor/shared/brain'
import { all, one, type Bind, type Context } from './database'
import { entity as entitySummary, entityNumber, referencedEntities } from './entities'
import { memoryCards } from './knowledge'

const PAGE_SIZE = 40
function cursor(value: number[]): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
function decode(value: string | null): number[] | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString())
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((n) => Number.isSafeInteger(n))
    )
      return parsed as number[]
  } catch {
    /* Report invalid cursors consistently. */
  }
  throw new Error('Brain page cursor is invalid.')
}
function connectionPage(
  ctx: Context,
  id: string,
  predicate: BrainPredicate,
  direction: 'out' | 'in',
  after: string | null,
  limit: number,
): BrainConnectionPage {
  const n = entityNumber(ctx, id)
  const own = direction === 'out' ? 'subject' : 'object'
  const other = direction === 'out' ? 'object' : 'subject'
  const key = decode(after)
  const rows = all<{
    n: number
    observed_at: number
    neighbour: string
    memoryId: string
    subjectId: string
    objectId: string
  }>(
    ctx,
    `SELECT r.n,r.observed_at,e.id AS neighbour,m.id AS memoryId,s.id AS subjectId,o.id AS objectId FROM relations r JOIN entities e ON e.n=r.${other} JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object JOIN memories m ON m.n=r.memory WHERE r.${own}=? AND r.live=1 AND r.predicate=? ${key ? 'AND (r.observed_at,r.n)<(?,?)' : ''} ORDER BY r.observed_at DESC,r.n DESC LIMIT ?`,
    n,
    predicate,
    ...(key ?? []),
    limit + 1,
  )
  const selected = rows.slice(0, limit)
  const items: BrainConnection[] = selected.map((row) => ({
    entity: entitySummary(ctx, row.neighbour)!,
    link: {
      id: String(row.n),
      subjectId: row.subjectId,
      objectId: row.objectId,
      predicate,
      memoryId: row.memoryId,
    },
  }))
  const last = selected.at(-1)
  return { items, next: rows.length > limit && last ? cursor([last.observed_at, last.n]) : null }
}
export function connections(
  ctx: Context,
  id: string,
  predicate: BrainPredicate,
  direction: 'out' | 'in',
  after: string | null,
): BrainConnectionPage {
  return connectionPage(ctx, id, predicate, direction, after, PAGE_SIZE)
}
export function entity(ctx: Context, id: string): BrainEntityView {
  const n = entityNumber(ctx, id)
  const groups = BRAIN_PREDICATES.flatMap((predicate) =>
    (['out', 'in'] as const).flatMap((direction) => {
      const column = direction === 'out' ? 'subject' : 'object'
      const total = one<{ total: number }>(
        ctx,
        `SELECT COUNT(*) AS total FROM relations WHERE ${column}=? AND live=1 AND predicate=?`,
        n,
        predicate,
      )!.total
      return total
        ? [
            {
              predicate,
              direction,
              total,
              ...connectionPage(ctx, id, predicate, direction, null, 8),
            },
          ]
        : []
    }),
  )
  const counts = all<{ type: string; total: number }>(
    ctx,
    "SELECT m.type,COUNT(*) AS total FROM mentions a JOIN memories m ON m.n=a.memory WHERE a.entity=? AND m.state IN ('active','disputed') GROUP BY m.type",
    n,
  )
  return {
    entity: entitySummary(ctx, id)!,
    groups,
    sources: all(
      ctx,
      'SELECT m.origin_session AS sessionId,m.origin_title AS title FROM mentions a JOIN memories m ON m.n=a.memory WHERE a.entity=? AND m.origin_session IS NOT NULL GROUP BY m.origin_session ORDER BY MAX(m.observed_at) DESC LIMIT 50',
      n,
    ),
    memoryCounts: Object.fromEntries(
      BRAIN_MEMORY_TYPES.map((type) => [type, counts.find((row) => row.type === type)?.total ?? 0]),
    ) as BrainEntityView['memoryCounts'],
    merged: all<{ label: string }>(
      ctx,
      'SELECT label FROM merges WHERE target=? ORDER BY recorded_at DESC LIMIT 100',
      n,
    ).map((row) => row.label),
  }
}
export function entityMemories(
  ctx: Context,
  id: string,
  filter: BrainMemoryFilter,
  after: string | null,
): BrainMemoryPage {
  const n = entityNumber(ctx, id)
  const key = decode(after)
  const states = filter.states ?? ['active', 'disputed']
  const conditions = [`a.entity=?`, `m.state IN (${states.map(() => '?').join(',')})`]
  const args: Bind[] = [n, ...states]
  if (filter.types?.length) {
    conditions.push(`m.type IN (${filter.types.map(() => '?').join(',')})`)
    args.push(...filter.types)
  }
  if (filter.sessionId) {
    conditions.push('m.origin_session=?')
    args.push(filter.sessionId)
  }
  if (key) {
    conditions.push('(m.observed_at,m.n)<(?,?)')
    args.push(...key)
  }
  const rows = all<{ id: string; n: number; observed_at: number }>(
    ctx,
    `SELECT m.id,m.n,m.observed_at FROM mentions a JOIN memories m ON m.n=a.memory WHERE ${conditions.join(' AND ')} ORDER BY m.observed_at DESC,m.n DESC LIMIT ?`,
    ...args,
    PAGE_SIZE + 1,
  )
  const selected = rows.slice(0, PAGE_SIZE)
  const last = selected.at(-1)
  const memories = memoryCards(
    ctx,
    selected.map((row) => row.id),
  )
  return {
    memories,
    entities: referencedEntities(ctx, memories),
    next: rows.length > PAGE_SIZE && last ? cursor([last.observed_at, last.n]) : null,
  }
}
