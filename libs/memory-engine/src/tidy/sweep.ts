import { fingerprintMemories } from './fingerprints'
import {
  emptyBrainTidyCoverage,
  type BrainTidyCoverage,
  type BrainTidySweep,
  type BrainTidyTouched,
} from '@phosphor/shared/brain-tidy'
import { all, one, run, transaction, type Context } from '../database'
import { bumpRevision } from '../prefs'
import { recountEntities } from '../entities'
import { sweepEntity } from './sweep-entities'
import { memoryCandidateCache } from './memory-candidates'
import { sweepBudget, sweepMemory } from './sweep-memories'
import { sweepLinks } from './sweep-links'

export const TIDY_CHUNK = 128
/** Rows the closing pass reads per call while looking for memories without a fingerprint. */
export const UNKEYED_WINDOW = 4096
interface Cursor extends BrainTidyCoverage {
  entityMax: number
  memoryMax: number
  /** The closing pass: memories whose fingerprint a deferred merge dropped behind the cursor. */
  unkeyed?: boolean
}
export function coverage(ctx: Context): Cursor {
  const row = one<Omit<Cursor, 'phase'> & { phase: string }>(
    ctx,
    `SELECT phase,cursor,entities,memories,total_entities AS totalEntities,total_memories AS totalMemories,entity_max AS entityMax,memory_max AS memoryMax,limited_checks AS limitedChecks,started_at AS startedAt,finished_at AS finishedAt FROM tidy_sweep WHERE singleton=1`,
  )!
  // Stored as its own phase; shown as the memories phase it closes.
  if (row.phase === 'unkeyed') return { ...row, phase: 'memories', unkeyed: true }
  return row.phase === 'entities' || row.phase === 'memories' || row.phase === 'done'
    ? { ...row, phase: row.phase }
    : { ...emptyBrainTidyCoverage(), entityMax: 0, memoryMax: 0 }
}
/**
 * Coverage as a sweep reports it: no cursor internals. A finished pass reports today's counts, because every
 * memory saved since is swept as it lands (or by maintenance right after); a pass in progress
 * reports the totals it set out to check.
 */
export function publicCoverage(ctx: Context, c: Cursor = coverage(ctx)): BrainTidyCoverage {
  const { entityMax: _entities, memoryMax: _memories, unkeyed: _unkeyed, ...shown } = c
  if (shown.phase !== 'done') return shown
  const counts = Object.fromEntries(
    all<{ key: string; value: string }>(
      ctx,
      "SELECT key,value FROM meta WHERE key IN ('memories','entities')",
    ).map((row) => [row.key, Number(row.value)]),
  )
  return { ...shown, totalMemories: counts.memories ?? 0, totalEntities: counts.entities ?? 0 }
}
function start(ctx: Context): Cursor {
  const c = { ...emptyBrainTidyCoverage(), startedAt: ctx.now(), entityMax: 0, memoryMax: 0 }
  for (const table of ['entities', 'memories'] as const) {
    const row = one<{ total: number; max: number }>(
      ctx,
      `SELECT COUNT(*) AS total,COALESCE(MAX(n),0) AS max FROM ${table}`,
    )!
    if (table === 'entities') {
      c.totalEntities = row.total
      c.entityMax = row.max
    } else {
      c.totalMemories = row.total
      c.memoryMax = row.max
    }
  }
  return c
}
function save(ctx: Context, c: Cursor): void {
  run(
    ctx,
    'UPDATE tidy_sweep SET phase=?,cursor=?,entities=?,memories=?,total_entities=?,total_memories=?,entity_max=?,memory_max=?,limited_checks=?,started_at=?,finished_at=? WHERE singleton=1',
    c.unkeyed ? 'unkeyed' : c.phase,
    c.cursor,
    c.entities,
    c.memories,
    c.totalEntities,
    c.totalMemories,
    c.entityMax,
    c.memoryMax,
    c.limitedChecks,
    c.startedAt,
    c.finishedAt,
  )
}
export function sweep(
  ctx: Context,
  input: BrainTidyTouched | 'all',
  preferredEntityId?: string,
): BrainTidySweep {
  return transaction(ctx, () => {
    let c = coverage(ctx)
    const result: BrainTidySweep = {
      coverage: c,
      suggestions: 0,
      folded: 0,
      unlinked: 0,
      operationIds: [],
    }
    const entities = input === 'all' ? [] : [...new Set(input.entityIds)]
    const memories =
      input === 'all'
        ? []
        : all<{ n: number }>(
            ctx,
            'SELECT n FROM memories WHERE id IN (SELECT value FROM json_each(?))',
            JSON.stringify(input.memoryIds),
          ).map((m) => m.n)
    if (input === 'all') {
      if (c.startedAt === null || c.phase === 'done') c = start(ctx)
      if (c.unkeyed) memories.push(...nextUnkeyed(ctx, c))
      else nextChunk(ctx, c, entities, memories)
      // Counts stored before they meant current memories and distinct neighbours catch up here.
      recountEntities(
        ctx,
        new Set(
          all<{ n: number }>(
            ctx,
            'SELECT n FROM entities WHERE id IN (SELECT value FROM json_each(?))',
            JSON.stringify(entities),
          ).map((row) => row.n),
        ),
      )
    }
    for (const id of entities) {
      const found = sweepEntity(ctx, id, preferredEntityId)
      result.suggestions += found.suggestions
      c.limitedChecks += found.capped
    }
    fingerprintMemories(ctx, memories)
    const cache = memoryCandidateCache()
    const budget = memories.length ? sweepBudget(ctx) : { modelOnly: 0 }
    for (const n of memories) {
      const found = sweepMemory(ctx, n, cache, budget)
      result.suggestions += found.suggestions
      c.limitedChecks += found.capped
      result.operationIds.push(...found.operations)
    }
    result.folded = result.operationIds.length
    // A finished pass offers every pair named together that no link explains. New memories offer
    // the pairs they name, so a saved read's pair waits before the automatic check decides.
    if (input === 'all' ? c.phase === 'done' : memories.length > 0)
      result.unlinked = sweepLinks(ctx, input === 'all' ? undefined : memories)
    if (result.suggestions || result.unlinked) bumpRevision(ctx)
    if (input === 'all') save(ctx, c)
    result.coverage = publicCoverage(ctx, c)
    return result
  })
}
function nextChunk(ctx: Context, c: Cursor, entities: string[], memories: number[]): void {
  const table = c.phase === 'entities' ? 'entities' : 'memories'
  const max = c.phase === 'entities' ? c.entityMax : c.memoryMax
  const rows = all<{ n: number; id: string }>(
    ctx,
    `SELECT n,id FROM ${table} WHERE n>? AND n<=? ORDER BY n LIMIT ?`,
    c.cursor,
    max,
    TIDY_CHUNK,
  )
  for (const row of rows) {
    if (table === 'entities') entities.push(row.id)
    else memories.push(row.n)
  }
  c.cursor = rows.at(-1)?.n ?? max
  c[table] += rows.length
  if (rows.length < TIDY_CHUNK || c.cursor >= max) {
    c.phase = 'memories'
    c.cursor = 0
    if (table === 'memories') c.unkeyed = true
  }
}
/**
 * Active memories without a fingerprint, read in bounded windows of the primary key so the pass
 * stays cheap at a million memories. The pass is done only when a window finds none left.
 */
function nextUnkeyed(ctx: Context, c: Cursor): number[] {
  const rows = all<{ n: number; unkeyed: number }>(
    ctx,
    `SELECT m.n AS n,(m.state='active' AND k.memory IS NULL) AS unkeyed
      FROM (SELECT n,state FROM memories WHERE n>? ORDER BY n LIMIT ?) m
      LEFT JOIN tidy_memory_keys k ON k.memory=m.n ORDER BY m.n`,
    c.cursor,
    UNKEYED_WINDOW,
  )
  const found: number[] = []
  for (const row of rows) {
    c.cursor = row.n
    if (row.unkeyed) found.push(row.n)
    if (found.length === TIDY_CHUNK) return found
  }
  if (rows.length < UNKEYED_WINDOW) {
    c.phase = 'done'
    c.unkeyed = false
    c.cursor = 0
    c.finishedAt = ctx.now()
  }
  return found
}
