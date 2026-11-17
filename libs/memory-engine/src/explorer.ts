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
type Side = 'subject' | 'object'
const sideIndex = (side: Side) => (side === 'subject' ? 'relations_out' : 'relations_in')
/**
 * A subquery about one (entity, neighbour) pair, run through the index of whichever side has
 * fewer connections. Binds the entity's own connection count once.
 */
function pairProbe(own: Side, other: Side, query: (from: string, pair: string) => string): string {
  const pair = `x.${other}=r.${other} AND x.live=1 AND x.predicate=r.predicate AND x.${own}=r.${own}`
  const through = (side: Side) => query(`relations x INDEXED BY ${sideIndex(side)}`, pair)
  return `CASE WHEN e.connections<=? THEN (${through(other)}) ELSE (${through(own)}) END`
}
/**
 * One row per neighbour through this predicate and direction. The walk follows the entity's own
 * index newest first and keeps a link only when no newer live link joins the same pair, so a
 * page reads about `limit` rows per supporting memory and the cursor stays stateless. The newer
 * link check and the support count use the smaller side's index, so a page of a hub, or a page
 * that links into a hub, never reads the hub's whole range.
 */
function connectionPage(
  ctx: Context,
  id: string,
  predicate: BrainPredicate,
  direction: 'out' | 'in',
  after: string | null,
  limit: number,
): BrainConnectionPage {
  const own = direction === 'out' ? 'subject' : 'object'
  const other = direction === 'out' ? 'object' : 'subject'
  const self = one<{ n: number; connections: number }>(
    ctx,
    'SELECT n,connections FROM entities WHERE id=?',
    id,
  )
  if (!self) throw new Error('Brain entity not found.')
  const key = decode(after)
  const newer = pairProbe(
    own,
    other,
    (from, pair) =>
      `SELECT 1 FROM ${from} WHERE ${pair} AND x.observed_at>=r.observed_at AND (x.observed_at>r.observed_at OR x.n>r.n)`,
  )
  const supports = pairProbe(
    own,
    other,
    (from, pair) => `SELECT COUNT(*) FROM ${from} WHERE ${pair}`,
  )
  const rows = all<{
    n: number
    observed_at: number
    neighbour: string
    memoryId: string
    subjectId: string
    objectId: string
    supports: number
  }>(
    ctx,
    `SELECT r.n,r.observed_at,e.id AS neighbour,m.id AS memoryId,s.id AS subjectId,o.id AS objectId,
      ${supports} AS supports
      FROM relations r INDEXED BY ${sideIndex(own)}
      JOIN entities e ON e.n=r.${other} JOIN entities s ON s.n=r.subject
      JOIN entities o ON o.n=r.object JOIN memories m ON m.n=r.memory
      WHERE r.${own}=? AND r.live=1 AND r.predicate=? ${key ? 'AND (r.observed_at,r.n)<(?,?)' : ''}
      AND ${newer} IS NULL
      ORDER BY r.observed_at DESC,r.n DESC LIMIT ?`,
    self.connections,
    self.n,
    predicate,
    ...(key ?? []),
    self.connections,
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
    supports: row.supports,
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
      const other = direction === 'out' ? 'object' : 'subject'
      const total = one<{ total: number }>(
        ctx,
        `SELECT COUNT(DISTINCT ${other}) AS total FROM relations WHERE ${column}=? AND live=1 AND predicate=?`,
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
      'SELECT m.origin_session AS sessionId,m.origin_title AS title,COUNT(*) AS memories FROM mentions a JOIN memories m ON m.n=a.memory WHERE a.entity=? AND m.origin_session IS NOT NULL GROUP BY m.origin_session ORDER BY MAX(m.observed_at) DESC LIMIT 50',
      n,
    ),
    lastLearnedAt:
      one<{ newest: number | null }>(
        ctx,
        "SELECT MAX(m.observed_at) AS newest FROM mentions a JOIN memories m ON m.n=a.memory WHERE a.entity=? AND m.state IN ('active','disputed')",
        n,
      )?.newest ?? null,
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
