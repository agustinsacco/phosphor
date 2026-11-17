import { all, one, run, type Context } from '../database'
import { memoryCandidates, type MemoryCandidateCache } from './memory-candidates'
import { fingerprintOf, writeFingerprint } from './fingerprints'
import { changeMemories } from './operations'
import { offer, pairKnown, pairKey, UNCHECKED, type SuggestionRow } from './suggestions'
import { tokens } from '../text'

// Calibration: true paraphrase/contradiction pairs scored 0.86; topic-only pairs <= 0.80.
// Candidates only ask for review, so favour recall; fingerprints alone permit automatic folds.
const NEAR_MEMORY_COSINE = 0.84
/** Disagreements across lanes usually score 0.55-0.75; below this a pair is only a topic match. */
const MODEL_ONLY_COSINE = 0.6
const PARAPHRASE_COSINE = 0.75
const ASSERTIONS = ['fact', 'decision', 'preference']
const NEGATIONS = new Set(['no', 'not', 'never', 'without', 'cannot'])
const MODEL_ONLY_PER_MEMORY = 2
/** Model-only pairs one sweep call may queue, and how many may wait unjudged at once. */
export const MODEL_ONLY_PER_CHUNK = 16
export const MODEL_ONLY_QUEUE = 400
export interface SweepBudget {
  modelOnly: number
}
/** A full queue defers the rest: an unqueued pair is found again by the next pass. */
export function sweepBudget(ctx: Context): SweepBudget {
  const waiting = one<{ count: number }>(
    ctx,
    `SELECT COUNT(*) AS count FROM (SELECT 1 FROM tidy_suggestions WHERE state='open' AND kind='${UNCHECKED}' LIMIT ${MODEL_ONLY_QUEUE})`,
  )!.count
  return { modelOnly: Math.min(MODEL_ONLY_PER_CHUNK, MODEL_ONLY_QUEUE - waiting) }
}
interface SweptMemory {
  id: string
  type: string
  summary: string
  scope: string
  branch: string | null
  lane: string | null
  state: string
}

export function sweepMemory(
  ctx: Context,
  n: number,
  cache: MemoryCandidateCache,
  budget: SweepBudget,
): { suggestions: number; operations: string[]; capped: number } {
  const result = { suggestions: 0, operations: [] as string[], capped: 0 }
  const fingerprint = writeFingerprint(ctx, n)
  const row = one<SweptMemory>(
    ctx,
    'SELECT id,type,summary,scope,branch,origin_session AS lane,state FROM memories WHERE n=?',
    n,
  )
  if (!row || row.state === 'superseded') return result
  if (!fingerprint) return nearMemory(ctx, n, row, result, cache, budget)
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
  return nearMemory(ctx, n, row, result, cache, budget)
}
function nearMemory(
  ctx: Context,
  n: number,
  row: SweptMemory,
  result: { suggestions: number; operations: string[]; capped: number },
  cache: MemoryCandidateCache,
  budget: SweepBudget,
): typeof result {
  const candidates = memoryCandidates(ctx, n, cache)
  result.capped += candidates.capped
  const fingerprint = fingerprintOf(ctx, n)
  let hidden = 0
  for (const peer of candidates.items) {
    if (peer.score < MODEL_ONLY_COSINE) break
    if (peer.score < NEAR_MEMORY_COSINE) {
      const reason = modelOnlyReason(row, peer)
      if (!reason || pairKnown(ctx, 'memory', row.id, peer.id)) continue
      if (sharedEntities(ctx, n, peer.n) < 2) continue
      if (hidden >= MODEL_ONLY_PER_MEMORY || budget.modelOnly <= 0) {
        result.capped++
        break
      }
      offer(ctx, 'memory', row.id, peer.id, reason, UNCHECKED)
      hidden++
      budget.modelOnly--
      continue
    }
    if (result.suggestions >= 8) continue
    // A near pass must not reserve an exact pair before its cursor reaches the peer.
    if (fingerprint && fingerprintOf(ctx, peer.n) === fingerprint) continue
    if (pairKnown(ctx, 'memory', row.id, peer.id)) continue
    const opposed = negations(row.summary) !== negations(summaryOf(ctx, peer.n))
    let reason = opposed ? 'These may disagree.' : 'These two sentences say nearly the same thing.'
    if (peer.scope !== row.scope) reason += ' They come from different projects.'
    else if (peer.branch !== row.branch) reason += ' They come from different branches.'
    if (offer(ctx, 'memory', row.id, peer.id, reason, opposed ? 'conflict' : 'same_memory'))
      result.suggestions++
  }
  return result
}
/**
 * Pairs below the review threshold that only the model check sees: a possible disagreement
 * between lanes or projects, or a looser paraphrase. Both need two shared people or things.
 */
function modelOnlyReason(
  row: SweptMemory,
  peer: { score: number; type: string; scope: string; lane: string | null },
): string | null {
  const elsewhere =
    peer.scope !== row.scope || (!!peer.lane && !!row.lane && peer.lane !== row.lane)
  if (peer.type === row.type && ASSERTIONS.includes(row.type) && elsewhere)
    return 'These may disagree.'
  return peer.score >= PARAPHRASE_COSINE ? 'These two sentences may say the same thing.' : null
}
function sharedEntities(ctx: Context, first: number, second: number): number {
  return one<{ shared: number }>(
    ctx,
    'SELECT COUNT(*) AS shared FROM mentions a JOIN mentions b ON b.memory=? AND b.entity=a.entity WHERE a.memory=?',
    second,
    first,
  )!.shared
}
function summaryOf(ctx: Context, n: number): string {
  return one<{ summary: string }>(ctx, 'SELECT summary FROM memories WHERE n=?', n)?.summary ?? ''
}
/** Negation markers; a near pair whose counts differ may say opposite things. */
export function negations(text: string): number {
  const words = tokens(text.replace(/n['\u2019]t(?![\p{L}\p{N}_])/giu, ' not'))
  let count = 0
  for (let i = 0; i < words.length; i++)
    if (NEGATIONS.has(words[i]!) || (words[i] === 'instead' && words[i + 1] === 'of')) count++
  return count
}
