import type { BrainEntity } from '@phosphor/shared/brain'
import { all, one, run, type Context } from './database'
import type { RawEntity } from './types'

export function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
}
export function tokens(value: string): string[] {
  return fold(value).match(/[\p{L}\p{N}_]+/gu) ?? []
}
export function wholePhrase(text: string, phrase: string): boolean {
  const escaped = fold(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    !!escaped &&
    new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(fold(text))
  )
}
type EntityRow = Omit<BrainEntity, 'aliases'> & { aliases: string }
function decode(row: EntityRow): BrainEntity {
  return { ...row, aliases: JSON.parse(row.aliases) as string[] }
}
export function entities(ctx: Context): BrainEntity[] {
  return all<EntityRow>(
    ctx,
    'SELECT id,label,kind,aliases FROM entities ORDER BY created_at, rowid',
  ).map(decode)
}
export function entity(ctx: Context, id: string): BrainEntity | undefined {
  const row = one<EntityRow>(ctx, 'SELECT id,label,kind,aliases FROM entities WHERE id=?', id)
  return row && decode(row)
}
export function referencedEntities(
  ctx: Context,
  memories: { subjectId: string; objectId: string | null }[],
): BrainEntity[] {
  const ids = new Set(memories.flatMap((memory) => [memory.subjectId, memory.objectId]))
  return entities(ctx).filter((item) => ids.has(item.id))
}
export function resolveEntity(ctx: Context, raw: RawEntity): string {
  const names = new Set([raw.label, ...raw.aliases].map(fold))
  const existing = entities(ctx).find(
    (item) =>
      item.kind === raw.kind && [item.label, ...item.aliases].some((name) => names.has(fold(name))),
  )
  if (!existing) {
    const id = ctx.id()
    run(
      ctx,
      'INSERT INTO entities VALUES (?,?,?,?,?)',
      id,
      raw.label,
      raw.kind,
      JSON.stringify(mergeAliases(raw.label, raw.aliases)),
      ctx.now(),
    )
    return id
  }
  const aliases = mergeAliases(existing.label, [...existing.aliases, raw.label, ...raw.aliases])
  run(ctx, 'UPDATE entities SET aliases=? WHERE id=?', JSON.stringify(aliases), existing.id)
  return existing.id
}
function mergeAliases(label: string, aliases: string[]): string[] {
  const seen = new Set([fold(label)])
  return aliases.filter((alias) => {
    const name = fold(alias)
    if (!name || seen.has(name)) return false
    seen.add(name)
    return true
  })
}
export function cleanOrphans(ctx: Context): void {
  run(
    ctx,
    'DELETE FROM evidence WHERE NOT EXISTS (SELECT 1 FROM citations WHERE evidence_id=evidence.id)',
  )
  run(
    ctx,
    `DELETE FROM entities WHERE NOT EXISTS (SELECT 1 FROM memories
    WHERE state='active' AND (subject_id=entities.id OR object_id=entities.id))`,
  )
}
/** Aliases are global: approving a new alias must also make earlier memories searchable by it. */
export function rebuildFts(ctx: Context): void {
  run(ctx, 'DELETE FROM memory_fts')
  const byId = new Map(
    entities(ctx).map((item) => [item.id, [item.label, ...item.aliases].join(' ')]),
  )
  const rows = all<{
    id: string
    subject_id: string
    object_id: string | null
    summary: string
    literal: string | null
  }>(ctx, "SELECT id, subject_id, object_id, summary, literal FROM memories WHERE state='active'")
  for (const row of rows) {
    run(
      ctx,
      'INSERT INTO memory_fts VALUES (?,?)',
      row.id,
      [row.summary, row.literal, byId.get(row.subject_id), row.object_id && byId.get(row.object_id)]
        .filter(Boolean)
        .join(' '),
    )
  }
}
