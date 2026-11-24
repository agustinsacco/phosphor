import { LINK, endedLinks } from './relation-reads'
import { togetherNames } from './together'
import {
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  type BrainConnection,
  type BrainLink,
  type BrainMemoryType,
  type BrainConnectionPage,
  type BrainEntityView,
  type BrainMemoryFilter,
  type BrainMemoryPage,
  type BrainPredicate,
} from '@phosphor/shared/brain'
import { all, one, type Bind, type Context } from './database'
import {
  entity as entitySummary,
  entityNumber,
  survivingEntityId,
  referencedEntities,
} from './entities'
import { memoryCards } from './knowledge'
import { INSTANT, newerLink, pairProbe, sideIndex } from './relation-pairs'

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
  now = ctx.now(),
): BrainConnectionPage {
  id = survivingEntityId(ctx, id)
  const own = direction === 'out' ? 'subject' : 'object'
  const other = direction === 'out' ? 'object' : 'subject'
  const self = one<{ n: number; connections: number }>(
    ctx,
    'SELECT n,connections FROM entities WHERE id=?',
    id,
  )
  if (!self) throw new Error('Brain entity not found.')
  const key = decode(after)
  const newer = newerLink(own, other)
  const supports = pairProbe(
    own,
    other,
    (from, pair) => `SELECT COUNT(*) FROM ${from} WHERE ${pair}`,
  )
  const rows = all<
    {
      n: number
      observed_at: number
      neighbour: string
      supports: number
    } & BrainLink
  >(
    ctx,
    `WITH ${INSTANT} SELECT r.n,r.observed_at,e.id AS neighbour,${LINK},
      ${supports} AS supports
      FROM relations r INDEXED BY ${sideIndex(own)}
      JOIN entities e ON e.n=r.${other} JOIN entities s ON s.n=r.subject
      JOIN entities o ON o.n=r.object JOIN memories m ON m.n=r.memory
      WHERE r.${own}=? AND r.live=1 AND (r.valid_to IS NULL OR r.valid_to>(SELECT now FROM instant)) AND r.predicate=? ${key ? 'AND (r.observed_at,r.n)<(?,?)' : ''}
      AND ${newer} IS NULL
      ORDER BY r.observed_at DESC,r.n DESC LIMIT ?`,
    now,
    self.connections,
    self.n,
    predicate,
    ...(key ?? []),
    self.connections,
    limit + 1,
  )
  const selected = rows.slice(0, limit)
  const items: BrainConnection[] = selected.map(
    ({ n: _n, observed_at: _at, neighbour, supports, ...link }) => ({
      entity: entitySummary(ctx, neighbour)!,
      link,
      supports,
    }),
  )
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
/**
 * Current (active or disputed) memories in one pass over the entity's mentions, so the header,
 * type counts, lanes and last-learned time always agree. The mentions index leads the join.
 */
function currentMemories(
  ctx: Context,
  n: number,
): Pick<BrainEntityView, 'memoryCounts' | 'sources' | 'lastLearnedAt'> & { total: number } {
  const rows = all<{
    sessionId: string | null
    title: string | null
    type: BrainMemoryType
    total: number
    newest: number
  }>(
    ctx,
    `SELECT m.origin_session AS sessionId,m.origin_title AS title,m.type,COUNT(*) AS total,MAX(m.observed_at) AS newest
      FROM mentions a CROSS JOIN memories m ON m.n=a.memory
      WHERE a.entity=? AND m.state IN ('active','disputed') GROUP BY m.origin_session,m.type`,
    n,
  )
  const memoryCounts = Object.fromEntries(BRAIN_MEMORY_TYPES.map((type) => [type, 0])) as Record<
    BrainMemoryType,
    number
  >
  const lanes = new Map<string, BrainEntityView['sources'][number] & { newest: number }>()
  for (const row of rows) {
    if (row.type in memoryCounts) memoryCounts[row.type] += row.total
    if (row.sessionId === null) continue
    const lane = lanes.get(row.sessionId)
    if (!lane)
      lanes.set(row.sessionId, {
        sessionId: row.sessionId,
        title: row.title ?? '',
        memories: row.total,
        newest: row.newest,
      })
    else {
      lane.memories += row.total
      if (row.newest > lane.newest) Object.assign(lane, { newest: row.newest, title: row.title })
    }
  }
  return {
    total: rows.reduce((sum, row) => sum + row.total, 0),
    memoryCounts,
    lastLearnedAt: rows.length ? Math.max(...rows.map((row) => row.newest)) : null,
    sources: [...lanes.values()]
      .sort((a, b) => b.newest - a.newest || a.sessionId.localeCompare(b.sessionId))
      .slice(0, 50)
      .map(({ newest: _newest, ...lane }) => lane),
  }
}
export function entity(ctx: Context, id: string, now = ctx.now()): BrainEntityView {
  id = survivingEntityId(ctx, id)
  const n = entityNumber(ctx, id)
  const groups = BRAIN_PREDICATES.flatMap((predicate) =>
    (['out', 'in'] as const).flatMap((direction) => {
      const column = direction === 'out' ? 'subject' : 'object'
      const other = direction === 'out' ? 'object' : 'subject'
      const total = one<{ total: number }>(
        ctx,
        `SELECT COUNT(DISTINCT ${other}) AS total FROM relations WHERE ${column}=? AND live=1 AND (valid_to IS NULL OR valid_to>?) AND predicate=?`,
        n,
        now,
        predicate,
      )!.total
      return total
        ? [
            {
              predicate,
              direction,
              total,
              ...connectionPage(ctx, id, predicate, direction, null, 8, now),
            },
          ]
        : []
    }),
  )
  const { total, ...current } = currentMemories(ctx, n)
  return {
    // Live counts: a record stored before counts meant current memories still agrees here.
    entity: {
      ...entitySummary(ctx, id)!,
      memories: total,
      connections: groups.reduce((sum, group) => sum + group.total, 0),
    },
    groups,
    ended: endedLinks(ctx, id, now).map((link) => ({
      link,
      entity: entitySummary(ctx, link.subjectId === id ? link.objectId : link.subjectId)!,
      supports: 1,
    })),
    ...togetherNames(ctx, n, now),
    ...current,
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
  id = survivingEntityId(ctx, id)
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
