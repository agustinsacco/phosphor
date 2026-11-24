import { foldGuard, disputeGuard, replaceGuard } from './action-guards'
import { all, one, run, type Context } from '../database'
import { reactivatePartners } from '../commit'
import { carryRelations, copySupport, mergeRelationInto, relationsOf } from '../carry'
import { adjustCount, cleanOrphans, recountEntities } from '../entities'

export function foldMemories(ctx: Context, source: number, target: number): void {
  const refusal = foldGuard(ctx, source, target)
  if (refusal) throw new Error(refusal)
  const a = one<Record<string, unknown>>(ctx, 'SELECT * FROM memories WHERE n=?', source)!
  const evidence = new Set(
    all<{ evidence: number }>(
      ctx,
      'SELECT evidence FROM citations WHERE memory=? UNION SELECT s.evidence FROM relation_support s JOIN relations r ON r.n=s.relation WHERE r.memory=?',
      source,
      source,
    ).map((r) => r.evidence),
  )
  run(
    ctx,
    'INSERT OR IGNORE INTO mentions SELECT ?,entity FROM mentions WHERE memory=?',
    target,
    source,
  )
  transferLinks(ctx, source, target)
  run(
    ctx,
    `INSERT OR IGNORE INTO citations SELECT ?,c.evidence,c.quote FROM citations c JOIN evidence e ON e.n=c.evidence WHERE c.memory=? AND NOT EXISTS(SELECT 1 FROM citations t JOIN evidence te ON te.n=t.evidence WHERE t.memory=? AND t.quote=c.quote AND te.entry_id=e.entry_id)`,
    target,
    source,
    target,
  )
  run(
    ctx,
    'UPDATE memories SET observed_at=MAX(observed_at,?) WHERE n=?',
    Number(a.observed_at),
    target,
  )
  run(
    ctx,
    'UPDATE relations SET observed_at=(SELECT observed_at FROM memories WHERE n=?) WHERE memory=?',
    target,
    target,
  )
  run(ctx, 'DELETE FROM memory_words WHERE rowid=?', source)
  run(ctx, 'DELETE FROM memories WHERE n=?', source)
  adjustCount(ctx, 'memories', -1)
  const entities = new Set(
    all<{ entity: number }>(ctx, 'SELECT entity FROM mentions WHERE memory=?', target).map(
      (r) => r.entity,
    ),
  )
  cleanOrphans(ctx, new Set(), evidence)
  recountEntities(ctx, entities)
}
/** Every link moves with its wording, dates, speaker and support; the same link said twice merges. */
function transferLinks(ctx: Context, source: number, target: number): void {
  const existing = relationsOf(ctx, target)
  for (const r of relationsOf(ctx, source)) {
    const same = existing.find(
      (x) => x.subject === r.subject && x.predicate === r.predicate && x.object === r.object,
    )
    if (same) {
      mergeRelationInto(ctx, r, same.n)
      continue
    }
    run(
      ctx,
      `INSERT INTO relations(memory,subject,predicate,object,live,observed_at,label,valid_from,valid_to,stated_by)
      SELECT ?,subject,predicate,object,live,observed_at,label,valid_from,valid_to,stated_by FROM relations WHERE n=?`,
      target,
      r.n,
    )
    copySupport(ctx, r.n, one<{ n: number }>(ctx, 'SELECT last_insert_rowid() AS n')!.n)
  }
}
export function conflictMemories(
  ctx: Context,
  first: number,
  second: number,
  replace: boolean,
): void {
  const refusal = (replace ? replaceGuard : disputeGuard)(ctx, first, second)
  if (refusal) throw new Error(refusal)
  if (replace) {
    const start = one<{ valid_from: number | null }>(
      ctx,
      'SELECT valid_from FROM memories WHERE n=?',
      first,
    )!.valid_from
    carryRelations(ctx, second, first, start ?? ctx.now())
    reactivatePartners(ctx, second)
    run(
      ctx,
      "UPDATE memories SET state='superseded',valid_to=COALESCE((SELECT valid_from FROM memories WHERE n=?),?) WHERE n=?",
      first,
      ctx.now(),
      second,
    )
    run(ctx, 'UPDATE relations SET live=0 WHERE memory=?', second)
    run(ctx, 'DELETE FROM memory_words WHERE rowid=?', second)
    run(ctx, 'DELETE FROM memory_bits WHERE memory=?', second)
    adjustCount(ctx, 'memories', -1)
  } else run(ctx, "UPDATE memories SET state='disputed' WHERE n IN (?,?)", first, second)
  run(
    ctx,
    'INSERT OR IGNORE INTO memory_links VALUES (?,?,?,?)',
    first,
    second,
    replace ? 'supersedes' : 'conflicts',
    ctx.now(),
  )
  recountEntities(
    ctx,
    new Set(
      all<{ entity: number }>(
        ctx,
        'SELECT entity FROM mentions WHERE memory IN (?,?)',
        first,
        second,
      ).map((r) => r.entity),
    ),
  )
}
