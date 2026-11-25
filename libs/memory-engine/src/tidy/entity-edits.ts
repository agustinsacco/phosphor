import type { JournalNote } from '../agent/notes'
import { BRAIN_ENTITY_KINDS, type BrainEntityKind } from '@phosphor/shared/brain'
import { BRAIN_SYMMETRIC_PREDICATES } from '@phosphor/shared/brain-links'
import { all, one, run, transaction, type Context } from '../database'
import { createEntity, entityNumber, recountEntities, refreshEntityWords } from '../entities'
import { bumpKnowledgeRevision } from '../prefs'
import { scrubExcerpt } from '../secrets'
import { fold } from '../text'
import { fingerprintMemories } from './fingerprints'
import { checkRevision, journal } from './journal'
import type { RowTable } from './rows'
import { offer, pairKey } from './suggestions'

interface EntityRow {
  n: number
  id: string
  label: string
  description: string
}
function record(ctx: Context, id: string): EntityRow {
  const row = one<EntityRow>(ctx, 'SELECT n,id,label,description FROM entities WHERE id=?', id)
  if (!row) throw new Error('This person or thing is no longer in Brain.')
  return row
}
const ENTITY_ROW = new Set<RowTable>(['entities'])
const NAMES = new Set<RowTable>(['entity_names'])

/** Replaces a description (trimmed, 1–160 characters, scrubbed like a read's). Undoable. */
export function describeEntity(
  ctx: Context,
  id: string,
  value: string,
  expected: number,
  note?: JournalNote,
): string {
  const description = scrubExcerpt(value.trim())
  if (!description || description.length > 160)
    throw new Error('A description needs 1 to 160 characters.')
  return transaction(ctx, () => {
    checkRevision(ctx, expected)
    const entity = record(ctx, id)
    if (entity.description === description)
      throw new Error(`${entity.label} already has this description.`)
    const operation = journal(
      ctx,
      {
        kind: 'describe',
        subjects: { type: 'entity', first: id, second: id },
        selection: { entities: [entity.n], memories: [] },
        only: ENTITY_ROW,
        note,
        summary: `Changed the description of ${entity.label}`,
      },
      () => {
        run(ctx, 'UPDATE entities SET description=? WHERE n=?', description, entity.n)
        refreshEntityWords(ctx, entity.n)
      },
    )
    bumpKnowledgeRevision(ctx)
    return operation
  })
}

/**
 * Names two records share (folded) that one of them could lose: never that record's own label.
 * Bounded by the name limit Tidy already uses.
 */
export function removableNames(
  ctx: Context,
  first: string,
  second: string,
): { entityId: string; folded: string }[] {
  const [a, b] = [first, second].map((id) =>
    one<{ n: number; label: string }>(ctx, 'SELECT n,label FROM entities WHERE id=?', id),
  )
  if (!a || !b) return []
  const shared = all<{ folded: string }>(
    ctx,
    'SELECT a.folded FROM entity_names a JOIN entity_names b ON b.folded=a.folded WHERE a.entity=? AND b.entity=? ORDER BY a.n LIMIT 16',
    a.n,
    b.n,
  )
  return shared.flatMap(({ folded }) =>
    [
      { entityId: first, label: a.label },
      { entityId: second, label: b.label },
    ]
      .filter((side) => fold(side.label) !== folded)
      .map((side) => ({ entityId: side.entityId, folded })),
  )
}
/** Caller owns the transaction and the revision. Never removes the label. */
export function removeNameChange(
  ctx: Context,
  id: string,
  name: string,
  suggestionId?: string,
  note?: JournalNote,
): string {
  const entity = record(ctx, id)
  if (fold(name) === fold(entity.label))
    throw new Error(`"${entity.label}" is the main name of this record, so Brain keeps it.`)
  const row = one<{ n: number; name: string }>(
    ctx,
    'SELECT n,name FROM entity_names WHERE entity=? AND folded=?',
    entity.n,
    fold(name),
  )
  if (!row) throw new Error(`${entity.label} has no other name "${name}".`)
  return journal(
    ctx,
    {
      kind: 'unname',
      subjects: { type: 'entity', first: id, second: id },
      selection: { entities: [entity.n], memories: [] },
      only: NAMES,
      summary: `Removed the name "${row.name}" from ${entity.label}`,
      suggestionId,
      note,
    },
    () => {
      run(ctx, 'DELETE FROM entity_grams WHERE rowid=?', row.n)
      run(ctx, 'DELETE FROM entity_names WHERE n=?', row.n)
      refreshEntityWords(ctx, entity.n)
    },
  )
}
export function removeName(
  ctx: Context,
  id: string,
  name: string,
  expected: number,
  note?: JournalNote,
): string {
  return transaction(ctx, () => {
    checkRevision(ctx, expected)
    const operation = removeNameChange(ctx, id, name, undefined, note)
    bumpKnowledgeRevision(ctx)
    return operation
  })
}

export interface SplitTarget {
  label: string
  kind: BrainEntityKind
}
/**
 * Moves the chosen memories' mentions, and the links they support, from one record to a new one
 * named `target.label`. Aliases, keys and merge history stay on the original. Undoable.
 * At least one current (active or disputed) memory must stay. A superseded memory moves only
 * when chosen; one left behind stays on the original, and Undo never touches it.
 */
export function splitEntity(
  ctx: Context,
  id: string,
  memoryIds: string[],
  target: SplitTarget,
  expected: number,
  note?: JournalNote,
): string {
  const label = target.label.trim()
  if (
    memoryIds.length < 1 ||
    memoryIds.length > 200 ||
    new Set(memoryIds).size !== memoryIds.length
  )
    throw new Error('Choose 1 to 200 memories to split off.')
  if (!label || label.length > 80) throw new Error('A name needs 1 to 80 characters.')
  if (!BRAIN_ENTITY_KINDS.includes(target.kind)) throw new Error('Invalid Brain entity kind.')
  return transaction(ctx, () => {
    checkRevision(ctx, expected)
    const entity = record(ctx, id)
    const chosen = all<{ n: number; current: number }>(
      ctx,
      "SELECT a.memory AS n,m.state IN ('active','disputed') AS current FROM mentions a JOIN memories m ON m.n=a.memory WHERE a.entity=? AND m.id IN (SELECT value FROM json_each(?))",
      entity.n,
      JSON.stringify(memoryIds),
    )
    if (chosen.length !== memoryIds.length)
      throw new Error(`Every memory to split off must name ${entity.label}.`)
    const moving = chosen.map((row) => row.n)
    const current = one<{ total: number }>(
      ctx,
      "SELECT COUNT(*) AS total FROM mentions a JOIN memories m ON m.n=a.memory WHERE a.entity=? AND m.state IN ('active','disputed')",
      entity.n,
    )!.total
    if (chosen.filter((row) => row.current).length >= current)
      throw new Error(
        `Splitting off every memory is a rename; keep at least one memory on ${entity.label}.`,
      )
    const input = {
      kind: 'split' as const,
      subjects: { type: 'entity' as const, first: id, second: id },
      selection: { entities: [] as number[], memories: moving },
      note,
      summary: `Split ${label} from ${entity.label}`,
    }
    const operation = journal(ctx, input, () => {
      const created = createEntity(ctx, {
        label,
        kind: target.kind,
        aliases: [],
        description: '',
        keys: [],
      })
      input.subjects.second = created
      moveMemories(ctx, entity.n, entityNumber(ctx, created), moving)
      input.selection.entities.push(entityNumber(ctx, created))
    })
    // The owner just said these are two different records.
    offer(ctx, 'entity', id, input.subjects.second, 'You split these apart; they stay separate.')
    run(
      ctx,
      "UPDATE tidy_suggestions SET state='dismissed',updated_at=? WHERE pair_key=?",
      ctx.now(),
      pairKey('entity', id, input.subjects.second),
    )
    bumpKnowledgeRevision(ctx)
    return operation
  })
}
function moveMemories(ctx: Context, from: number, to: number, memories: number[]): void {
  const json = JSON.stringify(memories)
  const touched = new Set([from, to])
  for (const row of all<{ subject: number; object: number }>(
    ctx,
    'SELECT subject,object FROM relations WHERE memory IN (SELECT value FROM json_each(?)) AND (subject=? OR object=?)',
    json,
    from,
    from,
  ))
    touched.add(row.subject === from ? row.object : row.subject)
  run(
    ctx,
    'UPDATE mentions SET entity=? WHERE entity=? AND memory IN (SELECT value FROM json_each(?))',
    to,
    from,
    json,
  )
  run(
    ctx,
    `UPDATE relations SET subject=CASE WHEN subject=? THEN ? ELSE subject END,
      object=CASE WHEN object=? THEN ? ELSE object END
      WHERE memory IN (SELECT value FROM json_each(?)) AND (subject=? OR object=?)`,
    from,
    to,
    from,
    to,
    json,
    from,
    from,
  )
  // The new record has the highest number, so a moved symmetric link may now face the wrong way.
  run(
    ctx,
    `UPDATE relations SET subject=object,object=subject
      WHERE memory IN (SELECT value FROM json_each(?)) AND subject=? AND subject>object
      AND predicate IN (SELECT value FROM json_each(?))`,
    json,
    to,
    JSON.stringify(BRAIN_SYMMETRIC_PREDICATES),
  )
  recountEntities(ctx, touched)
  fingerprintMemories(ctx, memories)
}
