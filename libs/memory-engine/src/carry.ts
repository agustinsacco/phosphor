/**
 * Relation conservation: a write that replaces a memory carries each link the change does not
 * contradict to the surviving memory, with its wording, dates, speaker and support.
 */
import {
  BRAIN_SINGLE_VALUED_PREDICATES,
  type BrainLink,
  type BrainPredicate,
  type BrainStatedBy,
} from '@phosphor/shared/brain-links'
import { all, one, run, type Context } from './database'
import { recountEntities } from './entities'
import { fingerprintMemories } from './tidy/fingerprints'

export interface RelationRow {
  n: number
  memory: number
  subject: number
  predicate: BrainPredicate
  object: number
  label: string
  valid_from: number | null
  valid_to: number | null
  stated_by: BrainStatedBy
}
const COLUMNS = 'n,memory,subject,predicate,object,label,valid_from,valid_to,stated_by'
const SINGLE = new Set<string>(BRAIN_SINGLE_VALUED_PREDICATES)

export function relationsOf(ctx: Context, memory: number): RelationRow[] {
  return all<RelationRow>(ctx, `SELECT ${COLUMNS} FROM relations WHERE memory=? ORDER BY n`, memory)
}
/** Unions support, deduplicated by entry and quote, from one relation into another. */
export function copySupport(ctx: Context, from: number, to: number): void {
  run(
    ctx,
    `INSERT OR IGNORE INTO relation_support SELECT ?,s.evidence,s.quote FROM relation_support s JOIN evidence e ON e.n=s.evidence WHERE s.relation=? AND NOT EXISTS(SELECT 1 FROM relation_support t JOIN evidence te ON te.n=t.evidence WHERE t.relation=? AND t.quote=s.quote AND te.entry_id=e.entry_id)`,
    to,
    from,
    to,
  )
}
/**
 * The same link said twice: the kept one takes the other's wording when it has none and its
 * start when it has none, and every quote. Its end and speaker stay: the newer statement wins.
 */
export function mergeRelationInto(ctx: Context, from: RelationRow, into: number): void {
  run(
    ctx,
    "UPDATE relations SET label=CASE WHEN label='' THEN ? ELSE label END,valid_from=COALESCE(valid_from,?) WHERE n=?",
    from.label,
    from.valid_from,
    into,
  )
  copySupport(ctx, from.n, into)
}
/** Copies a link onto another memory with its support and the mentions of both ends. */
export function copyRelation(
  ctx: Context,
  r: RelationRow,
  to: number,
  validTo: number | null,
): number {
  run(
    ctx,
    `INSERT INTO relations(memory,subject,predicate,object,live,observed_at,label,valid_from,valid_to,stated_by)
    SELECT ?,?,?,?,state!='superseded',observed_at,?,?,?,? FROM memories WHERE n=?`,
    to,
    r.subject,
    r.predicate,
    r.object,
    r.label,
    r.valid_from,
    validTo,
    r.stated_by,
    to,
  )
  const n = one<{ n: number }>(ctx, 'SELECT last_insert_rowid() AS n')!.n
  copySupport(ctx, r.n, n)
  run(ctx, 'INSERT OR IGNORE INTO mentions VALUES (?,?),(?,?)', to, r.subject, to, r.object)
  return n
}
/**
 * The surviving memory states the same predicate and object with another subject (a new owner),
 * or, for a single-valued predicate, the same subject and predicate with another object.
 */
export function contradicted(r: RelationRow, stated: RelationRow[]): boolean {
  return stated.some(
    (x) =>
      x.predicate === r.predicate &&
      ((x.object === r.object && x.subject !== r.subject) ||
        (SINGLE.has(r.predicate) && x.subject === r.subject && x.object !== r.object)),
  )
}
/**
 * Runs before `from` is retired. A contradicted link, or one named in `ends`, is carried ended at
 * `endAt` unless it already ended. Returns the links now on `to` that came from `from`, and those
 * among them it ended.
 */
export function carryRelations(
  ctx: Context,
  from: number,
  to: number,
  endAt: number,
  ends: ReadonlySet<number> = new Set(),
): { carried: number[]; ended: number[] } {
  const now = ctx.now()
  const existing = relationsOf(ctx, to)
  const stated = existing.filter((r) => r.valid_to === null || r.valid_to > now)
  const carried: number[] = [],
    ended: number[] = []
  const touched = new Set<number>()
  for (const r of relationsOf(ctx, from)) {
    touched.add(r.subject).add(r.object)
    const same = existing.find(
      (x) => x.subject === r.subject && x.predicate === r.predicate && x.object === r.object,
    )
    if (same) {
      mergeRelationInto(ctx, r, same.n)
      carried.push(same.n)
      continue
    }
    const end = ends.has(r.n) || contradicted(r, stated)
    const n = copyRelation(ctx, r, to, end ? (r.valid_to ?? endAt) : r.valid_to)
    carried.push(n)
    if (end) ended.push(n)
  }
  recountEntities(ctx, touched)
  fingerprintMemories(ctx, [to])
  return { carried, ended }
}
/** Links as the contract shows them, in the order given. */
export function brainLinks(ctx: Context, relations: number[]): BrainLink[] {
  if (!relations.length) return []
  const rows = new Map(
    all<BrainLink & { n: number }>(
      ctx,
      `SELECT r.n,CAST(r.n AS TEXT) AS id,s.id AS subjectId,r.predicate,o.id AS objectId,m.id AS memoryId,
      r.label,r.valid_from AS validFrom,r.valid_to AS validTo,r.stated_by AS statedBy
      FROM json_each(?) j JOIN relations r ON r.n=j.value JOIN memories m ON m.n=r.memory
      JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object`,
      JSON.stringify(relations),
    ).map(({ n, ...link }) => [n, link]),
  )
  return relations.flatMap((n) => rows.get(n) ?? [])
}
