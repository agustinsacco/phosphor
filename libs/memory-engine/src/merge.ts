import { eraseTidyMemory } from './tidy/erase'
import { all, one, run, transaction, type Context } from './database'
import {
  addNames,
  adjustCount,
  cleanOrphans,
  entity,
  entityNumber,
  recountEntities,
} from './entities'
import { BRAIN_SYMMETRIC_PREDICATES } from '@phosphor/shared/brain-links'
import { mergeRelationInto, type RelationRow } from './carry'
import { reactivatePartners } from './commit'
import { memoryNumber } from './knowledge'
import { bumpKnowledgeRevision } from './prefs'
import { pruneExtractions } from './extractions'

const SYMMETRIC = new Set<string>(BRAIN_SYMMETRIC_PREDICATES)

export function mergeRows(ctx: Context, sourceId: string, targetId: string): void {
  if (sourceId === targetId) throw new Error('Choose two different Brain entities.')
  {
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
  }
}
export function forget(ctx: Context, id: string): void {
  transaction(ctx, () => {
    removeMemory(ctx, id)
    bumpKnowledgeRevision(ctx)
    pruneExtractions(ctx)
  })
}
/**
 * The caller owns the transaction, the revision bump and the extraction prune, so replacing a
 * read is atomic and does that global work once, not once per memory.
 */
export function removeMemory(ctx: Context, id: string): void {
  const n = memoryNumber(ctx, id)
  eraseTidyMemory(ctx, id, n)
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
}

/**
 * Links follow the merged record. One that already exists on its memory absorbs the moved one's
 * wording, start and support; one that would join the record to itself goes, on purpose (F25).
 */
function repointRelations(
  ctx: Context,
  source: number,
  target: number,
  touched: Set<number>,
): void {
  const relations = all<RelationRow>(
    ctx,
    'SELECT * FROM relations WHERE subject=? UNION SELECT * FROM relations WHERE object=?',
    source,
    source,
  )
  for (const row of relations) {
    let subject = row.subject === source ? target : row.subject
    let object = row.object === source ? target : row.object
    touched.add(subject)
    touched.add(object)
    if (SYMMETRIC.has(row.predicate) && object < subject) [subject, object] = [object, subject]
    if (subject !== object) {
      const duplicate = one<{ n: number }>(
        ctx,
        'SELECT n FROM relations WHERE memory=? AND subject=? AND predicate=? AND object=? AND n!=?',
        row.memory,
        subject,
        row.predicate,
        object,
        row.n,
      )
      if (duplicate) mergeRelationInto(ctx, row, duplicate.n)
      else {
        run(ctx, 'UPDATE relations SET subject=?,object=? WHERE n=?', subject, object, row.n)
        continue
      }
    }
    run(ctx, 'DELETE FROM relations WHERE n=?', row.n)
  }
}
