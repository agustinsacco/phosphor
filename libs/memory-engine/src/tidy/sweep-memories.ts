import { all, one, run, type Context } from '../database'
import { memoryCandidates, type MemoryCandidateCache } from './memory-candidates'
import { fingerprintOf, writeFingerprint } from './fingerprints'
import { changeMemories } from './operations'
import { offer, pairKnown, pairKey, type SuggestionRow } from './suggestions'

// Calibration: true paraphrase/contradiction pairs scored 0.86; topic-only pairs <= 0.80.
// Candidates only ask for review, so favour recall; fingerprints alone permit automatic folds.
const NEAR_MEMORY_COSINE = 0.84

export function sweepMemory(
  ctx: Context,
  n: number,
  cache: MemoryCandidateCache,
): { suggestions: number; operations: string[]; capped: number } {
  const result = { suggestions: 0, operations: [] as string[], capped: 0 }
  const fingerprint = writeFingerprint(ctx, n)
  const row = one<{ id: string; scope: string; branch: string | null; state: string }>(
    ctx,
    'SELECT id,scope,branch,state FROM memories WHERE n=?',
    n,
  )
  if (!row || row.state === 'superseded') return result
  if (!fingerprint) return nearMemory(ctx, n, row, result, cache)
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
    cache.windows.clear() // A fold changes mentions and removes a cached memory.
    return result
  }
  return nearMemory(ctx, n, row, result, cache)
}
function nearMemory(
  ctx: Context,
  n: number,
  row: { id: string; scope: string; branch: string | null },
  result: { suggestions: number; operations: string[]; capped: number },
  cache: MemoryCandidateCache,
): typeof result {
  const candidates = memoryCandidates(ctx, n, cache)
  result.capped += candidates.capped
  const fingerprint = fingerprintOf(ctx, n)
  for (const peer of candidates.items) {
    if (peer.score < NEAR_MEMORY_COSINE) break
    // A near pass must not reserve an exact pair before its cursor reaches the peer.
    if (fingerprint && fingerprintOf(ctx, peer.n) === fingerprint) continue
    if (pairKnown(ctx, 'memory', row.id, peer.id)) continue
    let reason = 'These two sentences say nearly the same thing.'
    if (peer.scope !== row.scope) reason += ' They come from different projects.'
    else if (peer.branch !== row.branch) reason += ' They come from different branches.'
    if (offer(ctx, 'memory', row.id, peer.id, reason)) result.suggestions++
    if (result.suggestions >= 8) break
  }
  return result
}
