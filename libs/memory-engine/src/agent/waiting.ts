import {
  BRAIN_POSSIBLE_REPEATS_PER_RUN,
  type BrainWaitingCounts,
  type BrainWaitingItem,
} from '@phosphor/shared/brain-agent'
import type { BrainTidyKind } from '@phosphor/shared/brain-tidy'
import { all, one, run, type Context } from '../database'
import { COUNTED, suggestion, type SuggestionRow } from '../tidy/suggestions'
import { scrubExcerpt } from '../secrets'

/** Counts and the agent's queue agree, including suggestions whose subjects disappeared. */
function closeMissing(ctx: Context): void {
  run(
    ctx,
    `UPDATE tidy_suggestions SET state='cleared',updated_at=? WHERE state='open' AND
    ((subject_type='entity' AND (NOT EXISTS(SELECT 1 FROM entities WHERE id=first_id) OR
      (second_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM entities WHERE id=second_id)))) OR
    (subject_type='memory' AND (NOT EXISTS(SELECT 1 FROM memories WHERE id=first_id) OR
      (second_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memories WHERE id=second_id)))))`,
    ctx.now(),
  )
}
const COUNT_KEY: Record<BrainTidyKind, keyof BrainWaitingCounts> = {
  same_entity: 'entities',
  group: 'groups',
  unlinked: 'unlinked',
  same_memory: 'repeats',
  conflict: 'conflicts',
  flagged: 'flags',
}
/** The order Brain Agent decides in: people and things, groups, unlinked pairs, repeats... */
const ORDER = `CASE kind WHEN 'same_entity' THEN 0 WHEN 'group' THEN 1 WHEN 'unlinked' THEN 2
  WHEN 'same_memory' THEN 3 WHEN 'conflict' THEN 4 ELSE 5 END`

export function waitingCounts(ctx: Context): BrainWaitingCounts {
  closeMissing(ctx)
  const counts: BrainWaitingCounts = {
    entities: 0,
    groups: 0,
    unlinked: 0,
    repeats: 0,
    conflicts: 0,
    flags: 0,
  }
  for (const row of all<{ kind: BrainTidyKind; count: number }>(
    ctx,
    `SELECT kind,COUNT(*) AS count FROM tidy_suggestions WHERE state='open' AND kind IN (${COUNTED}) GROUP BY kind`,
  ))
    counts[COUNT_KEY[row.kind]] = row.count
  return counts
}
/** Changes whenever a counted item opens or the count moves; an automatic run compares it. */
export function waitingSignature(ctx: Context): string {
  closeMissing(ctx)
  const row = one<{ count: number; newest: number | null }>(
    ctx,
    `SELECT COUNT(*) AS count,MAX(created_at) AS newest FROM tidy_suggestions WHERE state='open' AND kind IN (${COUNTED})`,
  )!
  return `${row.count}:${row.newest ?? 0}`
}
export function waitingSuggestions(
  ctx: Context,
  limit: number,
  possibleRepeats: number,
): { items: BrainWaitingItem[]; more: number } {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    !Number.isSafeInteger(possibleRepeats) ||
    possibleRepeats < 0
  )
    throw new Error('Invalid Brain Agent waiting limit.')
  possibleRepeats = Math.min(possibleRepeats, BRAIN_POSSIBLE_REPEATS_PER_RUN)
  closeMissing(ctx)
  const visible = all<SuggestionRow>(
    ctx,
    `SELECT * FROM tidy_suggestions WHERE state='open' AND kind IN (${COUNTED})
    ORDER BY ${ORDER},created_at,id LIMIT ?`,
    limit,
  )
  const unchecked = all<SuggestionRow>(
    ctx,
    "SELECT * FROM tidy_suggestions WHERE state='open' AND kind='unchecked' ORDER BY created_at,id LIMIT ?",
    possibleRepeats,
  )
  const count = one<{ n: number }>(
    ctx,
    `SELECT COUNT(*) AS n FROM tidy_suggestions WHERE state='open' AND kind IN (${COUNTED})`,
  )!.n
  const items = [...visible, ...unchecked].slice(0, limit).flatMap((row): BrainWaitingItem[] => {
    const item = suggestion(ctx, row, true)
    if (!item) return []
    return [
      {
        kind: row.kind === 'unchecked' ? 'possible_repeat' : item.kind,
        suggestionId: item.id,
        subjects: item.subjects.map((s) => ({
          ...s,
          label: scrubExcerpt(s.label).slice(0, s.type === 'entity' ? 160 : 1200),
        })),
        reason: scrubExcerpt(item.reason).slice(0, 300),
        problem: item.flag?.problem ?? null,
        createdAt: item.createdAt,
      },
    ]
  })
  return { items, more: Math.max(0, count + unchecked.length - items.length) }
}
