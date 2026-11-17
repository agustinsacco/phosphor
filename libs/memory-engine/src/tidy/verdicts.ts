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
import { closeMissing, type SuggestionRow } from './suggestions'

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
      `SELECT object AS n,predicate,'out' AS direction FROM relations WHERE subject=? AND live=1 UNION ALL SELECT subject AS n,predicate,'in' AS direction FROM relations WHERE object=? AND live=1 LIMIT 5`,
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
export function pendingPairs(ctx: Context, limit: number): BrainTidyPair[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 40)
    throw new Error('Invalid Tidy pair limit.')
  closeMissing(ctx)
  return all<SuggestionRow>(
    ctx,
    "SELECT * FROM tidy_suggestions WHERE state='open' AND verdict IS NULL AND second_id IS NOT NULL AND kind IN ('same_entity','same_memory','conflict') ORDER BY created_at,id LIMIT ?",
    limit,
  ).map((r) => ({
    suggestionId: r.id,
    subjects: [card(ctx, r.subject_type, r.first_id), card(ctx, r.subject_type, r.second_id!)],
  }))
}
export function recordVerdicts(ctx: Context, judgements: BrainTidyJudgement[]): void {
  if (judgements.length > 40) throw new Error('Too many Tidy verdicts.')
  transaction(ctx, () => {
    closeMissing(ctx)
    let changed = false
    for (const judgement of judgements) {
      const row = one<SuggestionRow>(
        ctx,
        "SELECT * FROM tidy_suggestions WHERE id=? AND state='open' AND verdict IS NULL AND second_id IS NOT NULL",
        judgement.suggestionId,
      )
      if (!row) continue
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
      run(
        ctx,
        `UPDATE tidy_suggestions SET kind=?,source='check',state=?,verdict=?,verdict_reason=?,newer_id=?,model=?,reason=?,updated_at=? WHERE id=?`,
        ['conflict', 'replaces'].includes(v.kind) ? 'conflict' : row.kind,
        v.kind === 'different' ? 'cleared' : 'open',
        v.kind,
        v.reason,
        v.kind === 'replaces' ? v.newerId : null,
        judgement.model,
        v.reason,
        ctx.now(),
        row.id,
      )
      changed = true
    }
    if (changed) bumpRevision(ctx)
  })
}
