import { createHash } from 'node:crypto'
import { all, one, run, type Context } from '../database'
import { fold } from '../text'

/** Mention identity and applicability are part of equality, never just the sentence. */
export function writeFingerprint(ctx: Context, n: number): string | null {
  const fingerprint = fingerprintOf(ctx, n)
  if (fingerprint === null) run(ctx, 'DELETE FROM tidy_memory_keys WHERE memory=?', n)
  else
    run(
      ctx,
      'INSERT INTO tidy_memory_keys VALUES (?,?) ON CONFLICT(memory) DO UPDATE SET fingerprint=excluded.fingerprint',
      n,
      fingerprint,
    )
  return fingerprint
}
/**
 * Reads without writing: a stored key marks a swept memory, so the closing maintenance pass
 * finds the memories a deferred merge left unswept by their missing key.
 */
export function fingerprintOf(ctx: Context, n: number): string | null {
  const row = one<{
    summary: string
    type: string
    scope: string
    branch: string | null
    valid_from: number | null
    valid_to: number | null
    state: string
  }>(ctx, 'SELECT summary,type,scope,branch,valid_from,valid_to,state FROM memories WHERE n=?', n)
  if (!row || row.state !== 'active') return null
  const entities = all<{ entity: number }>(
    ctx,
    'SELECT entity FROM mentions WHERE memory=? ORDER BY entity',
    n,
  ).map((r) => r.entity)
  return createHash('sha256')
    .update(
      JSON.stringify([
        fold(row.summary),
        row.type,
        row.scope,
        row.branch,
        row.valid_from,
        row.valid_to,
        entities,
      ]),
    )
    .digest('hex')
}
export function fingerprintMemories(ctx: Context, memories: number[]): void {
  for (const n of memories) writeFingerprint(ctx, n)
}
