import type { BrainTidyAction, BrainTidySuggestionDetail } from '@phosphor/shared/brain-tidy'
import { one, type Context } from '../database'
import { subjectExists, type SuggestionRow } from './suggestions'
import { removableNames } from './entity-edits'

export function sameApplicability(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ['scope', 'branch', 'valid_from', 'valid_to'].every((key) => a[key] === b[key])
}
export function foldRefusal(
  ctx: Context,
  first: number,
  second: number,
): 'applicability' | 'history' | null {
  const a = one<Record<string, unknown>>(ctx, 'SELECT * FROM memories WHERE n=?', first)
  const b = one<Record<string, unknown>>(ctx, 'SELECT * FROM memories WHERE n=?', second)
  if (!a || !b || first === second) return 'history'
  if (!sameApplicability(a, b)) return 'applicability'
  return a.state !== 'active' ||
    b.state !== 'active' ||
    one(
      ctx,
      'SELECT 1 FROM memory_links WHERE source IN (?,?) OR target IN (?,?) LIMIT 1',
      first,
      second,
      first,
      second,
    )
    ? 'history'
    : null
}
export function foldGuard(ctx: Context, first: number, second: number): string | null {
  const refusal = foldRefusal(ctx, first, second)
  return refusal === 'applicability'
    ? 'These memories have different scope, branch or validity dates; they cannot be folded.'
    : refusal === 'history'
      ? 'Resolve the history or dispute before folding these memories.'
      : null
}
function currentPairGuard(ctx: Context, first: number, second: number): string | null {
  if (first === second) return 'Choose two different Brain memories.'
  return [first, second].every((n) =>
    one(ctx, "SELECT 1 FROM memories WHERE n=? AND state IN ('active','disputed')", n),
  )
    ? null
    : 'This memory is no longer current.'
}
export function disputeGuard(ctx: Context, first: number, second: number): string | null {
  return (
    currentPairGuard(ctx, first, second) ??
    (one(
      ctx,
      "SELECT 1 FROM memory_links WHERE kind='conflicts' AND ((source=? AND target=?) OR (source=? AND target=?)) LIMIT 1",
      first,
      second,
      second,
      first,
    )
      ? 'These memories are already disputed with each other.'
      : null)
  )
}
export function replaceGuard(ctx: Context, first: number, second: number): string | null {
  return currentPairGuard(ctx, first, second)
}
export const memoryActionGuards = { fold: foldGuard, dispute: disputeGuard, replace: replaceGuard }

export function actionRefusal(
  ctx: Context,
  row: SuggestionRow,
  kind: BrainTidyAction['kind'],
  curator = false,
): string | null {
  if (row.state !== 'open') return 'This Tidy suggestion is no longer available.'
  if (!subjectExists(ctx, row)) return 'A subject of this suggestion is no longer available.'
  const mismatch = 'This action does not apply to this Tidy suggestion.'
  if (curator && kind === 'keep') return null
  if (curator && kind === 'forget') return 'Use brain_erase to erase a memory.'
  if (kind === 'keep' || kind === 'forget') return row.kind === 'flagged' ? null : mismatch
  if (!row.second_id || row.first_id === row.second_id) return mismatch
  if (kind === 'merge') return row.subject_type === 'entity' ? null : mismatch
  if (kind === 'unname')
    return row.subject_type !== 'entity'
      ? mismatch
      : removableNames(ctx, row.first_id, row.second_id).length
        ? null
        : 'These records share no other name that one of them could lose.'
  if (row.subject_type !== 'memory') return mismatch
  const first = one<{ n: number }>(ctx, 'SELECT n FROM memories WHERE id=?', row.first_id)!.n
  const second = one<{ n: number }>(ctx, 'SELECT n FROM memories WHERE id=?', row.second_id)!.n
  return memoryActionGuards[kind](ctx, first, second)
}
export function allowedActions(
  ctx: Context,
  row: SuggestionRow,
  curator = false,
): Pick<BrainTidySuggestionDetail, 'allowed' | 'foldRefusal'> {
  const kinds: BrainTidyAction['kind'][] = [
    'merge',
    'unname',
    'fold',
    'dispute',
    'replace',
    'forget',
    'keep',
  ]
  const allowed = kinds.filter((kind) => actionRefusal(ctx, row, kind, curator) === null)
  let refusal: 'applicability' | 'history' | null = null
  if (
    row.state === 'open' &&
    row.subject_type === 'memory' &&
    row.second_id &&
    subjectExists(ctx, row)
  ) {
    const first = one<{ n: number }>(ctx, 'SELECT n FROM memories WHERE id=?', row.first_id)!.n
    const second = one<{ n: number }>(ctx, 'SELECT n FROM memories WHERE id=?', row.second_id)!.n
    refusal = foldRefusal(ctx, first, second)
  }
  return { allowed, foldRefusal: refusal }
}
