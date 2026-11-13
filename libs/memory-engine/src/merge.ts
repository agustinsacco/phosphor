import { all, one, run, transaction, type Context } from './database'
import {
  addNames,
  adjustCount,
  cleanOrphans,
  entity,
  entityNumber,
  recountEntities,
} from './entities'
import { reactivatePartners } from './commit'
import { memoryNumber } from './knowledge'
import { bumpRevision } from './prefs'
import { pruneExtractions } from './extractions'

export function merge(ctx: Context, sourceId: string, targetId: string): void {
  if (sourceId === targetId) throw new Error('Choose two different Brain entities.')
  transaction(ctx, () => {
    const source = entityNumber(ctx, sourceId)
    const target = entityNumber(ctx, targetId)
    const label = entity(ctx, sourceId)!.label
    const touched = new Set([target])
    for (const row of all<{ memory: number }>(
      ctx,
      'SELECT memory FROM mentions WHERE entity=?',
      source,
    ))
      run(ctx, 'INSERT OR IGNORE INTO mentions VALUES (?,?)', row.memory, target)
    run(ctx, 'DELETE FROM mentions WHERE entity=?', source)
    repointRelations(ctx, source, target, touched)
    const names = all<{ n: number; name: string }>(
      ctx,
      'SELECT n,name FROM entity_names WHERE entity=?',
      source,
    )
    for (const row of names) run(ctx, 'DELETE FROM entity_grams WHERE rowid=?', row.n)
    run(
      ctx,
      'DELETE FROM entity_keys WHERE entity=? AND EXISTS(SELECT 1 FROM entity_keys t WHERE t.entity=? AND t.namespace=entity_keys.namespace AND t.value=entity_keys.value)',
      source,
      target,
    )
    run(ctx, 'UPDATE entity_keys SET entity=? WHERE entity=?', target, source)
    addNames(
      ctx,
      target,
      names.map((row) => row.name),
      [],
    )
    run(ctx, 'UPDATE merges SET target=? WHERE target=?', target, source)
    run(
      ctx,
      'INSERT INTO merges(source_id,target,label,reason,recorded_at) VALUES (?,?,?,?,?)',
      sourceId,
      target,
      label,
      'Merged by you',
      ctx.now(),
    )
    run(ctx, 'DELETE FROM entity_words WHERE rowid=?', source)
    run(ctx, 'DELETE FROM entities WHERE n=?', source)
    touched.delete(source)
    recountEntities(ctx, touched)
    adjustCount(ctx, 'entities', -1)
    bumpRevision(ctx)
  })
}
export function forget(ctx: Context, id: string): void {
  transaction(ctx, () => {
    const n = memoryNumber(ctx, id)
    const state = one<{ state: string }>(ctx, 'SELECT state FROM memories WHERE n=?', n)!.state
    const touched = new Set(
      all<{ entity: number }>(ctx, 'SELECT entity FROM mentions WHERE memory=?', n).map(
        (row) => row.entity,
      ),
    )
    const evidence = new Set(
      all<{ evidence: number }>(
        ctx,
        'SELECT evidence FROM citations WHERE memory=? UNION SELECT s.evidence FROM relation_support s JOIN relations r ON r.n=s.relation WHERE r.memory=?',
        n,
        n,
      ).map((row) => row.evidence),
    )
    reactivatePartners(ctx, n)
    run(ctx, 'DELETE FROM memory_words WHERE rowid=?', n)
    run(ctx, 'DELETE FROM memories WHERE n=?', n)
    if (state !== 'superseded') adjustCount(ctx, 'memories', -1)
    cleanOrphans(ctx, touched, evidence)
    recountEntities(ctx, touched)
    bumpRevision(ctx)
    pruneExtractions(ctx)
  })
}

function repointRelations(
  ctx: Context,
  source: number,
  target: number,
  touched: Set<number>,
): void {
  const relations = all<{
    n: number
    memory: number
    subject: number
    predicate: string
    object: number
    observed_at: number
  }>(
    ctx,
    'SELECT * FROM relations WHERE subject=? UNION SELECT * FROM relations WHERE object=?',
    source,
    source,
  )
  for (const row of relations) {
    const subject = row.subject === source ? target : row.subject
    const object = row.object === source ? target : row.object
    touched.add(subject)
    touched.add(object)
    if (subject !== object) {
      const duplicate = one<{ n: number }>(
        ctx,
        'SELECT n FROM relations WHERE memory=? AND subject=? AND predicate=? AND object=?',
        row.memory,
        subject,
        row.predicate,
        object,
      )
      if (duplicate)
        run(
          ctx,
          'INSERT OR IGNORE INTO relation_support SELECT ?,evidence,quote FROM relation_support WHERE relation=?',
          duplicate.n,
          row.n,
        )
      else {
        run(ctx, 'UPDATE relations SET subject=?,object=? WHERE n=?', subject, object, row.n)
        continue
      }
    }
    run(ctx, 'DELETE FROM relations WHERE n=?', row.n)
  }
}
