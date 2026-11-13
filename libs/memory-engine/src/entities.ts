import type { BrainEntity, BrainEntitySummary } from '@phosphor/shared/brain'
import { all, one, run, type Context } from './database'
import { nextNumber } from './prefs'
import { scrubExcerpt } from './secrets'
import { fold } from './text'
import type { EntityKey, ProposalEntity } from './types'
import { encodeVector } from './vectors'
import { encodeBits } from './bits'

export function entity(ctx: Context, id: string): BrainEntitySummary | undefined {
  const row = one<BrainEntitySummary & { n: number }>(
    ctx,
    'SELECT n,id,label,kind,description,memories,connections FROM entities WHERE id=?',
    id,
  )
  if (!row) return undefined
  const { n, ...value } = row
  return {
    ...value,
    aliases: all<{ name: string }>(
      ctx,
      'SELECT name FROM entity_names WHERE entity=? AND folded!=? ORDER BY n',
      n,
      fold(row.label),
    ).map((name) => name.name),
  }
}
export function entityNumber(ctx: Context, id: string): number {
  const row = one<{ n: number }>(ctx, 'SELECT n FROM entities WHERE id=?', id)
  if (!row) throw new Error('Brain entity not found.')
  return row.n
}
export function referencedEntities(
  ctx: Context,
  memories: { entityIds: string[] }[],
): BrainEntity[] {
  return [...new Set(memories.flatMap((memory) => memory.entityIds))].flatMap((id) => {
    const found = entity(ctx, id)
    return found ? [found] : []
  })
}
export function addNames(ctx: Context, n: number, names: string[], keys: EntityKey[]): void {
  for (const name of names) {
    if (!fold(name)) continue
    const clean = scrubExcerpt(name)
    const inserted = ctx.db
      .prepare('INSERT OR IGNORE INTO entity_names(entity,name,folded) VALUES (?,?,?)')
      .run(n, clean, fold(clean))
    if (inserted.changes)
      run(
        ctx,
        'INSERT INTO entity_grams(rowid,name) VALUES (?,?)',
        Number(inserted.lastInsertRowid),
        clean,
      )
  }
  for (const key of keys) {
    const owner = one<{ entity: number }>(
      ctx,
      'SELECT entity FROM entity_keys WHERE namespace=? AND value=?',
      key.namespace,
      key.value,
    )
    if (owner && owner.entity !== n)
      throw new Error('Brain identifier already belongs to another entity.')
    run(ctx, 'INSERT OR IGNORE INTO entity_keys VALUES (?,?,?)', key.namespace, key.value, n)
  }
  refreshEntityWords(ctx, n)
}
export function refreshEntityWords(ctx: Context, n: number): void {
  const row = one<{ description: string }>(ctx, 'SELECT description FROM entities WHERE n=?', n)!
  const names = all<{ name: string }>(ctx, 'SELECT name FROM entity_names WHERE entity=?', n)
  run(ctx, 'DELETE FROM entity_words WHERE rowid=?', n)
  run(
    ctx,
    'INSERT INTO entity_words(rowid,text) VALUES (?,?)',
    n,
    [...names.map((item) => item.name), row.description].join(' '),
  )
}
export function createEntity(
  ctx: Context,
  raw: Pick<ProposalEntity, 'label' | 'kind' | 'aliases' | 'description' | 'keys'>,
  vector?: Float32Array,
): string {
  const id = ctx.id()
  run(
    ctx,
    'INSERT INTO entities(n,id,label,kind,description,created_at) VALUES (?,?,?,?,?,?)',
    nextNumber(ctx, 'entities'),
    id,
    scrubExcerpt(raw.label),
    raw.kind,
    scrubExcerpt(raw.description),
    ctx.now(),
  )
  const n = entityNumber(ctx, id)
  addNames(ctx, n, [raw.label, ...raw.aliases], raw.keys)
  if (vector) {
    run(ctx, 'INSERT INTO entity_vectors VALUES (?,?)', n, encodeVector(vector))
    run(ctx, 'INSERT INTO entity_bits VALUES (?,?)', n, encodeBits(vector))
  }
  adjustCount(ctx, 'entities', 1)
  return id
}
export function adjustCount(ctx: Context, key: 'entities' | 'memories', delta: number): void {
  run(ctx, 'UPDATE meta SET value=CAST(value AS INTEGER)+? WHERE key=?', delta, key)
}
/** Only transaction-touched entities are checked; historical mentions keep them alive. */
export function cleanOrphans(
  ctx: Context,
  touched: Set<number>,
  evidence: Set<number> = new Set(),
): void {
  for (const n of touched) {
    if (one(ctx, 'SELECT 1 FROM mentions WHERE entity=? LIMIT 1', n)) continue
    if (!one(ctx, 'SELECT 1 FROM entities WHERE n=?', n)) continue
    run(ctx, 'DELETE FROM entity_words WHERE rowid=?', n)
    for (const name of all<{ n: number }>(ctx, 'SELECT n FROM entity_names WHERE entity=?', n))
      run(ctx, 'DELETE FROM entity_grams WHERE rowid=?', name.n)
    run(ctx, 'DELETE FROM entities WHERE n=?', n)
    adjustCount(ctx, 'entities', -1)
  }
  for (const n of evidence)
    run(
      ctx,
      'DELETE FROM evidence WHERE n=? AND NOT EXISTS(SELECT 1 FROM citations WHERE evidence=?) AND NOT EXISTS(SELECT 1 FROM relation_support WHERE evidence=?)',
      n,
      n,
      n,
    )
}
export function recountEntities(ctx: Context, touched: Set<number>): void {
  for (const n of touched) {
    run(
      ctx,
      `UPDATE entities SET memories=(SELECT COUNT(*) FROM mentions WHERE entity=?), connections=(SELECT COUNT(*) FROM relations WHERE subject=? AND live=1)+(SELECT COUNT(*) FROM relations WHERE object=? AND live=1) WHERE n=?`,
      n,
      n,
      n,
      n,
    )
  }
}
