import { all, one, run, type Context } from '../database'
import { reactivatePartners } from '../commit'
import { adjustCount, cleanOrphans, recountEntities } from '../entities'

export function sameApplicability(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ['scope', 'branch', 'valid_from', 'valid_to'].every((key) => a[key] === b[key])
}
export function foldMemories(ctx: Context, source: number, target: number): void {
  const a = one<Record<string, unknown>>(ctx, 'SELECT * FROM memories WHERE n=?', source)!
  const b = one<Record<string, unknown>>(ctx, 'SELECT * FROM memories WHERE n=?', target)!
  if (!sameApplicability(a, b))
    throw new Error(
      'These memories have different scope, branch or validity dates; they cannot be folded.',
    )
  if (
    a.state !== 'active' ||
    b.state !== 'active' ||
    one(
      ctx,
      'SELECT 1 FROM memory_links WHERE source IN (?,?) OR target IN (?,?) LIMIT 1',
      source,
      target,
      source,
      target,
    )
  )
    throw new Error('Resolve the history or dispute before folding these memories.')
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
function transferLinks(ctx: Context, source: number, target: number): void {
  for (const row of all<{
    n: number
    subject: number
    predicate: string
    object: number
    live: number
    observed_at: number
  }>(ctx, 'SELECT * FROM relations WHERE memory=?', source)) {
    run(
      ctx,
      'INSERT OR IGNORE INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (?,?,?,?,?,?)',
      target,
      row.subject,
      row.predicate,
      row.object,
      row.live,
      row.observed_at,
    )
    const to = one<{ n: number }>(
      ctx,
      'SELECT n FROM relations WHERE memory=? AND subject=? AND predicate=? AND object=?',
      target,
      row.subject,
      row.predicate,
      row.object,
    )!.n
    run(
      ctx,
      `INSERT OR IGNORE INTO relation_support SELECT ?,s.evidence,s.quote FROM relation_support s JOIN evidence e ON e.n=s.evidence WHERE s.relation=? AND NOT EXISTS(SELECT 1 FROM relation_support t JOIN evidence te ON te.n=t.evidence WHERE t.relation=? AND t.quote=s.quote AND te.entry_id=e.entry_id)`,
      to,
      row.n,
      to,
    )
  }
}
export function conflictMemories(
  ctx: Context,
  first: number,
  second: number,
  replace: boolean,
): void {
  if (replace) {
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
