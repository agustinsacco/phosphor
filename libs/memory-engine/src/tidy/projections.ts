import { all, one, run, type Context } from '../database'
import { recountEntities, refreshEntityWords } from '../entities'
import { encodeBits } from '../bits'
import { decodeVector } from '../vectors'
import type { Rows, Selection } from './rows'

export function affected(before: Rows, after: Rows, selection: Selection): Selection {
  const entities = new Set(selection.entities),
    memories = new Set(selection.memories)
  for (const rows of [before, after]) {
    for (const row of rows.get('mentions')?.values() ?? []) {
      entities.add(Number(row.entity))
      memories.add(Number(row.memory))
    }
    for (const row of rows.get('relations')?.values() ?? []) {
      entities.add(Number(row.subject))
      entities.add(Number(row.object))
      memories.add(Number(row.memory))
    }
  }
  return { entities: [...entities], memories: [...memories] }
}
export function rebuild(ctx: Context, selection: Selection, removedNames: number[]): void {
  for (const n of removedNames) run(ctx, 'DELETE FROM entity_grams WHERE rowid=?', n)
  for (const n of selection.entities) {
    run(ctx, 'DELETE FROM entity_words WHERE rowid=?', n)
    run(ctx, 'DELETE FROM entity_bits WHERE entity=?', n)
    if (!one(ctx, 'SELECT 1 FROM entities WHERE n=?', n)) continue
    refreshEntityWords(ctx, n)
    for (const row of all<{ n: number; name: string }>(
      ctx,
      'SELECT n,name FROM entity_names WHERE entity=?',
      n,
    )) {
      run(ctx, 'DELETE FROM entity_grams WHERE rowid=?', row.n)
      run(ctx, 'INSERT INTO entity_grams(rowid,name) VALUES (?,?)', row.n, row.name)
    }
    const vector = one<{ vector: Uint8Array }>(
      ctx,
      'SELECT vector FROM entity_vectors WHERE entity=?',
      n,
    )
    if (vector)
      run(ctx, 'INSERT INTO entity_bits VALUES (?,?)', n, encodeBits(decodeVector(vector.vector)))
  }
  for (const n of selection.memories) {
    run(ctx, 'DELETE FROM memory_words WHERE rowid=?', n)
    run(ctx, 'DELETE FROM memory_bits WHERE memory=?', n)
    const row = one<{ summary: string; state: string }>(
      ctx,
      'SELECT summary,state FROM memories WHERE n=?',
      n,
    )
    if (!row || row.state === 'superseded') continue
    run(ctx, 'INSERT INTO memory_words(rowid,summary) VALUES (?,?)', n, row.summary)
    const vector = one<{ vector: Uint8Array }>(
      ctx,
      'SELECT vector FROM memory_vectors WHERE memory=?',
      n,
    )
    if (vector)
      run(ctx, 'INSERT INTO memory_bits VALUES (?,?)', n, encodeBits(decodeVector(vector.vector)))
  }
  recountEntities(ctx, new Set(selection.entities))
  run(ctx, "UPDATE meta SET value=(SELECT COUNT(*) FROM entities) WHERE key='entities'")
  run(
    ctx,
    "UPDATE meta SET value=(SELECT COUNT(*) FROM memories WHERE state!='superseded') WHERE key='memories'",
  )
  // Undo restores old numeric keys, below the search worker's incremental watermark.
  run(
    ctx,
    "INSERT INTO meta VALUES ('vector_epoch','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
  )
}
