import { all, one, run, type Context } from '../database'
import { cosine, decodeVector } from '../vectors'
import { writeFingerprint } from './fingerprints'
import { changeMemories } from './operations'
import { offer, pairKnown, pairKey, type SuggestionRow } from './suggestions'

export function sweepMemory(
  ctx: Context,
  n: number,
): { suggestions: number; operations: string[]; capped: number } {
  const result = { suggestions: 0, operations: [] as string[], capped: 0 }
  const fingerprint = writeFingerprint(ctx, n)
  const row = one<{ id: string; scope: string; branch: string | null; state: string }>(
    ctx,
    'SELECT id,scope,branch,state FROM memories WHERE n=?',
    n,
  )
  if (!row || row.state === 'superseded') return result
  if (!fingerprint) return nearMemory(ctx, n, row, result)
  const exact = all<{ n: number; id: string }>(
    ctx,
    'SELECT m.n,m.id FROM (SELECT memory FROM tidy_memory_keys WHERE fingerprint=? ORDER BY memory LIMIT 17) k JOIN memories m ON m.n=k.memory',
    fingerprint,
  )
  if (exact.length > 16) result.capped++
  for (const peer of exact.slice(0, 16)) {
    if (peer.n === n) continue
    const previous = one<SuggestionRow>(
      ctx,
      'SELECT * FROM tidy_suggestions WHERE pair_key=?',
      pairKey('memory', row.id, peer.id),
    )
    if (
      previous &&
      (previous.state !== 'open' ||
        previous.kind !== 'same_memory' ||
        (previous.verdict !== null && previous.verdict !== 'same'))
    )
      continue
    if (
      one(
        ctx,
        'SELECT 1 FROM memory_links WHERE source IN (?,?) OR target IN (?,?) LIMIT 1',
        n,
        peer.n,
        n,
        peer.n,
      )
    )
      continue
    const source = n > peer.n ? row.id : peer.id,
      target = n > peer.n ? peer.id : row.id
    result.operations.push(
      changeMemories(ctx, source, target, 'fold', { automatic: true, suggestionId: previous?.id }),
    )
    if (previous)
      run(
        ctx,
        "UPDATE tidy_suggestions SET state='applied',updated_at=? WHERE id=?",
        ctx.now(),
        previous.id,
      )
    return result
  }
  return nearMemory(ctx, n, row, result)
}
function nearMemory(
  ctx: Context,
  n: number,
  row: { id: string; scope: string; branch: string | null },
  result: { suggestions: number; operations: string[]; capped: number },
): typeof result {
  const vector = one<{ vector: Uint8Array }>(
    ctx,
    'SELECT vector FROM memory_vectors WHERE memory=?',
    n,
  )
  if (!vector) return result
  const entities = all<{ entity: number }>(
    ctx,
    'SELECT entity FROM mentions WHERE memory=? ORDER BY entity LIMIT 5',
    n,
  )
  if (entities.length > 4) result.capped++
  const fingerprint = writeFingerprint(ctx, n)
  const seen = new Set<number>([n])
  for (const { entity } of entities.slice(0, 4)) {
    const candidates = all<{
      n: number
      id: string
      scope: string
      branch: string | null
      vector: Uint8Array
    }>(
      ctx,
      `SELECT m.n,m.id,m.scope,m.branch,v.vector FROM (SELECT memory FROM mentions WHERE entity=? AND memory!=? ORDER BY memory LIMIT 33) a JOIN memories m ON m.n=a.memory JOIN memory_vectors v ON v.memory=m.n WHERE m.state IN ('active','disputed')`,
      entity,
      n,
    )
    if (candidates.length > 32) result.capped++
    for (const peer of candidates.slice(0, 32)) {
      if (seen.has(peer.n)) continue
      seen.add(peer.n)
      // A near pass must not reserve an exact pair before its cursor reaches the peer.
      if (fingerprint && writeFingerprint(ctx, peer.n) === fingerprint) continue
      if (
        peer.scope !== row.scope ||
        peer.branch !== row.branch ||
        pairKnown(ctx, 'memory', row.id, peer.id)
      )
        continue
      if (cosine(decodeVector(vector.vector), decodeVector(peer.vector)) >= 0.92) {
        if (
          offer(
            ctx,
            'memory',
            row.id,
            peer.id,
            'These memories have very similar meaning and mention the same person or thing.',
          )
        )
          result.suggestions++
        return result
      }
    }
  }
  return result
}
