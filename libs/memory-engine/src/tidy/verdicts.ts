import {
  BRAIN_PREDICATE_LABELS,
  checkBrainReaderModel,
  type BrainEntityKind,
  type BrainMemoryType,
  type BrainPredicate,
} from '@phosphor/shared/brain'
import type { BrainTidyCard, BrainTidyJudgement, BrainTidyPair } from '@phosphor/shared/brain-tidy'
import { all, one, run, transaction, type Context } from '../database'
import { bumpRevision } from '../prefs'
import { closeMissing, UNCHECKED, type SuggestionRow } from './suggestions'

function card(ctx: Context, type: 'entity' | 'memory', id: string): BrainTidyCard {
  if (type === 'entity') {
    const row = one<{
      n: number
      label: string
      kind: BrainEntityKind
      description: string
      memories: number
    }>(ctx, 'SELECT * FROM entities WHERE id=?', id)!
    const aliases = all<{ name: string }>(
      ctx,
      'SELECT name FROM entity_names WHERE entity=? ORDER BY n LIMIT 8',
      row.n,
    ).map((r) => r.name.slice(0, 160))
    const links = all<{ n: number; predicate: BrainPredicate; direction: 'out' | 'in' }>(
      ctx,
      // Distinct neighbours from a bounded window of each side, so a hub never reads every link.
      `SELECT * FROM (SELECT object AS n,predicate,'out' AS direction FROM relations WHERE subject=? AND live=1 LIMIT 64) UNION SELECT * FROM (SELECT subject AS n,predicate,'in' AS direction FROM relations WHERE object=? AND live=1 LIMIT 64) LIMIT 5`,
      row.n,
      row.n,
    )
    return {
      type,
      id,
      name: row.label.slice(0, 160),
      kind: row.kind,
      description: row.description.slice(0, 160),
      memories: row.memories,
      aliases,
      neighbours: links.map((r) => ({
        name: one<{ label: string }>(ctx, 'SELECT label FROM entities WHERE n=?', r.n)!.label.slice(
          0,
          160,
        ),
        link: BRAIN_PREDICATE_LABELS[r.predicate][r.direction],
      })),
    }
  }
  const row = one<{
    n: number
    summary: string
    type: BrainMemoryType
    scope: string
    branch: string | null
    valid_from: number | null
    valid_to: number | null
    observed_at: number
  }>(ctx, 'SELECT * FROM memories WHERE id=?', id)!
  return {
    type,
    id,
    sentence: row.summary.slice(0, 1200),
    memoryType: row.type,
    scope: row.scope.slice(0, 500),
    branch: row.branch?.slice(0, 200) ?? null,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    observedAt: row.observed_at,
    entities: all<{ label: string }>(
      ctx,
      'SELECT e.label FROM mentions a JOIN entities e ON e.n=a.entity WHERE a.memory=? ORDER BY a.entity LIMIT 12',
      row.n,
    ).map((r) => r.label.slice(0, 160)),
    quotes: all<{ quote: string }>(
      ctx,
      'SELECT quote FROM citations WHERE memory=? LIMIT 2',
      row.n,
    ).map((r) => r.quote.slice(0, 300)),
  }
}
/**
 * The pairs one click checks, oldest first: every visible suggestion before any model-only pair,
 * so queued candidates only fill the budget visible suggestions leave.
 */
export function pendingPairs(ctx: Context, limit: number): BrainTidyPair[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 40)
    throw new Error('Invalid Tidy pair limit.')
  const pending = (kinds: string, room: number) =>
    room > 0
      ? all<SuggestionRow>(
          ctx,
          `SELECT * FROM tidy_suggestions WHERE state='open' AND verdict IS NULL AND second_id IS NOT NULL AND kind IN (${kinds}) ORDER BY created_at,id LIMIT ?`,
          room,
        )
      : []
  const visible = pending("'same_entity','same_memory','conflict'", limit)
  const rows = [...visible, ...pending(`'${UNCHECKED}'`, limit - visible.length)]
  closeMissing(ctx, rows)
  return rows
    .filter((r) => r.state === 'open')
    .map((r) => ({
      suggestionId: r.id,
      subjects: [card(ctx, r.subject_type, r.first_id), card(ctx, r.subject_type, r.second_id!)],
    }))
}

/**
 * Records the verdicts whose pair is still open. `settled` counts the rest: the owner answered,
 * merged or forgot the pair while the model was reading it.
 */
export function recordVerdicts(
  ctx: Context,
  judgements: BrainTidyJudgement[],
): { recorded: number; settled: number } {
  if (judgements.length > 40) throw new Error('Too many Tidy verdicts.')
  return transaction(ctx, () => {
    let recorded = 0
    for (const judgement of judgements) {
      const row = one<SuggestionRow>(
        ctx,
        "SELECT * FROM tidy_suggestions WHERE id=? AND state='open' AND verdict IS NULL AND second_id IS NOT NULL",
        judgement.suggestionId,
      )
      if (!row) continue
      closeMissing(ctx, [row])
      if (row.state !== 'open') continue
      const v = judgement.verdict
      checkBrainReaderModel(judgement.model)
      if (
        !['same', 'different', 'conflict', 'replaces'].includes(v.kind) ||
        !v.reason.trim() ||
        v.reason.length > 500
      )
        throw new Error('Invalid Tidy verdict.')
      if ((v.kind === 'replaces' || v.kind === 'conflict') && row.subject_type !== 'memory')
        throw new Error('Only memories can disagree or replace one another.')
      if (v.kind === 'replaces' && ![row.first_id, row.second_id].includes(v.newerId))
        throw new Error('Invalid newer memory in Tidy verdict.')
      // The model never takes two people or things off the owner's list; only "Not the same" does.
      const kept = v.kind === 'different' && row.subject_type === 'entity'
      const now = ctx.now()
      run(
        ctx,
        `UPDATE tidy_suggestions SET kind=?,source='check',state=?,verdict=?,verdict_reason=?,newer_id=?,model=?,reason=?,created_at=?,updated_at=? WHERE id=?`,
        ['conflict', 'replaces'].includes(v.kind)
          ? 'conflict'
          : row.subject_type === 'entity'
            ? 'same_entity'
            : 'same_memory',
        v.kind === 'different' && !kept ? 'cleared' : 'open',
        v.kind,
        v.reason,
        v.kind === 'replaces' ? v.newerId : null,
        judgement.model,
        kept ? row.reason : v.reason,
        // A model-only pair is new to the owner when it surfaces.
        row.kind === UNCHECKED ? now : row.created_at,
        now,
        row.id,
      )
      recorded++
    }
    if (recorded) bumpRevision(ctx)
    return { recorded, settled: judgements.length - recorded }
  })
}
