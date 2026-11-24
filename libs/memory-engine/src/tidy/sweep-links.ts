/**
 * Unlinked pairs: two people or things named together in at least two current memories with no
 * link saying how they relate. Brain Agent reads the memories and states the link or keeps them
 * apart, once; a pair it answered is never offered again.
 */
import { BRAIN_LINK_RULES, BRAIN_PREDICATES } from '@phosphor/shared/brain-links'
import type { BrainEntityKind } from '@phosphor/shared/brain'
import type { BrainTidySuggestionExtra } from '@phosphor/shared/brain-tidy'
import { all, one, run, type Context } from '../database'

/** Newest current memories read per pass. */
const WINDOW = 2000
/** Unlinked pairs open at once. */
export const UNLINKED_OPEN = 40
const HUB_MEMORIES = 2000
const HUB_CONNECTIONS = 200

interface Named {
  memory: number
  memoryId: string
  entity: number
  entityId: string
  kind: BrainEntityKind
  memories: number
}
interface Pair {
  a: Named
  b: Named
  memories: string[]
}
export function linkKey(first: string, second: string): string {
  return `link:${[first, second]
    .sort()
    .map((id) => Buffer.from(id).toString('hex'))
    .join('.')}`
}
function linkable(a: BrainEntityKind, b: BrainEntityKind): boolean {
  return BRAIN_PREDICATES.some((p) => {
    const rule = BRAIN_LINK_RULES[p]
    return (
      (rule.subject.includes(a) && rule.object.includes(b)) ||
      (rule.subject.includes(b) && rule.object.includes(a))
    )
  })
}
function eachPair(named: Named[], visit: (a: Named, b: Named, key: string) => void): void {
  for (let i = 0; i < named.length; i++)
    for (let j = i + 1; j < named.length; j++)
      visit(named[i]!, named[j]!, `${named[i]!.entity}.${named[j]!.entity}`)
}
/**
 * Pairs in the newest window, newest memory first, hubs left out. Given touched memories, only
 * the pairs those memories name, so a saved read does not rescan the whole window.
 */
function pairs(ctx: Context, touched?: number[]): Map<string, Pair> {
  const scoped = touched !== undefined
  const rows = all<Named>(
    ctx,
    `SELECT m.n AS memory,m.id AS memoryId,e.n AS entity,e.id AS entityId,e.kind,e.memories
    FROM (SELECT n,id,observed_at FROM memories WHERE state IN ('active','disputed')
      AND (valid_to IS NULL OR valid_to>?) ORDER BY observed_at DESC,n DESC LIMIT ?) m
    JOIN mentions a ON a.memory=m.n JOIN entities e ON e.n=a.entity
    WHERE e.memories<=? AND e.connections<=?${
      scoped
        ? ' AND e.n IN (SELECT entity FROM mentions WHERE memory IN (SELECT value FROM json_each(?)))'
        : ''
    } ORDER BY m.observed_at DESC,m.n DESC,e.n`,
    ctx.now(),
    WINDOW,
    HUB_MEMORIES,
    HUB_CONNECTIONS,
    ...(scoped ? [JSON.stringify(touched)] : []),
  )
  const byMemory = new Map<number, Named[]>()
  for (const row of rows) byMemory.set(row.memory, [...(byMemory.get(row.memory) ?? []), row])
  const named = new Set<string>()
  for (const n of touched ?? []) eachPair(byMemory.get(n) ?? [], (_a, _b, key) => named.add(key))
  const found = new Map<string, Pair>()
  for (const list of byMemory.values())
    eachPair(list, (a, b, key) => {
      if (scoped && !named.has(key)) return
      const pair = found.get(key) ?? { a, b, memories: [] }
      pair.memories.push(a.memoryId)
      found.set(key, pair)
    })
  return found
}
function explained(ctx: Context, a: number, b: number): boolean {
  return !!one(
    ctx,
    `SELECT 1 FROM relations r JOIN memories m ON m.n=r.memory WHERE m.state IN ('active','disputed')
    AND ((r.subject=? AND r.object=?) OR (r.subject=? AND r.object=?)) LIMIT 1`,
    a,
    b,
    b,
    a,
  )
}
/**
 * An open pair a link now explains (a read, `relate` or a group stated it) is answered: it frees
 * its slot, and keeping it would journal "No lasting link" for two linked records.
 */
export function clearExplainedPairs(ctx: Context): void {
  for (const row of all<{ id: string; a: number; b: number }>(
    ctx,
    `SELECT s.id,a.n AS a,b.n AS b FROM tidy_suggestions s JOIN entities a ON a.id=s.first_id
    JOIN entities b ON b.id=s.second_id WHERE s.state='open' AND s.kind='unlinked'`,
  ))
    if (explained(ctx, row.a, row.b))
      run(
        ctx,
        "UPDATE tidy_suggestions SET state='cleared',updated_at=? WHERE id=?",
        ctx.now(),
        row.id,
      )
}
/**
 * Offers the best unexplained pairs until UNLINKED_OPEN wait, from the whole window or only those
 * the touched memories name. Returns how many it offered.
 */
export function sweepLinks(ctx: Context, touched?: number[]): number {
  clearExplainedPairs(ctx)
  const open = one<{ n: number }>(
    ctx,
    "SELECT COUNT(*) AS n FROM tidy_suggestions WHERE state='open' AND kind='unlinked'",
  )!.n
  if (open >= UNLINKED_OPEN) return 0
  const total = Math.max(
    1,
    Number(one<{ value: string }>(ctx, "SELECT value FROM meta WHERE key='memories'")?.value ?? 1),
  )
  const idf = (memories: number) => Math.log(1 + total / (1 + memories)) / Math.log(1 + total)
  const ranked = [...pairs(ctx, touched).values()]
    .filter((p) => p.memories.length >= 2 && linkable(p.a.kind, p.b.kind))
    .map((p) => ({ ...p, score: p.memories.length * idf(p.a.memories) * idf(p.b.memories) }))
    .sort((x, y) => y.score - x.score)
  let offered = 0
  for (const pair of ranked) {
    if (open + offered >= UNLINKED_OPEN) break
    const key = linkKey(pair.a.entityId, pair.b.entityId)
    if (one(ctx, 'SELECT 1 FROM tidy_suggestions WHERE pair_key=?', key)) continue
    if (explained(ctx, pair.a.entity, pair.b.entity)) continue
    const detail: BrainTidySuggestionExtra = {
      kind: 'unlinked',
      shared: pair.memories.length,
      memoryIds: pair.memories.slice(0, 8),
    }
    const now = ctx.now()
    run(
      ctx,
      `INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,detail,created_at,updated_at)
      VALUES (?,?,'unlinked','sweep','open','entity',?,?,?,?,?,?)`,
      ctx.id(),
      key,
      pair.a.entityId,
      pair.b.entityId,
      `Named together in ${pair.memories.length} memories; no link says how they relate.`,
      JSON.stringify(detail),
      now,
      now,
    )
    offered++
  }
  return offered
}
