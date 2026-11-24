/**
 * Who a saved read's people and things are. `reuse` and `new` save as decided; an unsure identity
 * saves as a new record with a guess for Brain Agent (a duplicate is cheaper than a wrong merge),
 * reusing a pending guess for the same name so repeated reads do not pile up duplicates.
 */
import { createHash } from 'node:crypto'
import type { BrainTidySuggestionExtra } from '@phosphor/shared/brain-tidy'
import { all, one, run, type Context } from './database'
import {
  addNames,
  createEntity,
  entity,
  entityNumber,
  refreshEntityWords,
  replaceEntityVector,
  survivingEntityId,
} from './entities'
import { fold } from './text'
import { pairKey } from './tidy/suggestions'
import type { Proposal, ProposalEntity } from './types'

export interface ResolvedIdentities {
  resolve: (ref: string) => string
  /** New `same_entity` guesses opened. */
  guesses: () => number
}
export function identityResolver(ctx: Context, value: Proposal): ResolvedIdentities {
  const resolved = new Map<string, string>()
  let guesses = 0
  const resolve = (ref: string): string => {
    const cached = resolved.get(ref)
    if (cached) return cached
    const index = value.entities.findIndex((item) => item.ref === ref)
    const item = value.entities[index]
    if (!item) {
      entityNumber(ctx, ref)
      return ref
    }
    const vector = value.entityVectors[index]
    let id: string
    if (item.decision === 'reuse' && item.entityId) id = reuse(ctx, item, item.entityId, vector)
    else if (item.decision === 'new') id = createEntity(ctx, item, vector)
    else {
      const pending = pendingGuess(ctx, item)
      if (pending) id = reuse(ctx, item, pending, vector)
      else {
        id = createEntity(ctx, item, vector)
        if (openGuess(ctx, id, item.candidates[0], value.jobId)) guesses++
      }
    }
    if (item.owner && !owner(ctx)) setOwnerEntity(ctx, id)
    resolved.set(ref, id)
    return id
  }
  return { resolve, guesses: () => guesses }
}
/** The read's names join the record; its description fills only an empty stored one. */
function reuse(ctx: Context, item: ProposalEntity, id: string, vector?: Float32Array): string {
  const n = entityNumber(ctx, id)
  addNames(ctx, n, [item.label, ...item.aliases], item.keys)
  const stored = one<{ description: string }>(ctx, 'SELECT description FROM entities WHERE n=?', n)!
  if (!stored.description.trim() && item.description.trim()) {
    run(ctx, 'UPDATE entities SET description=? WHERE n=?', item.description, n)
    refreshEntityWords(ctx, n)
    if (vector) replaceEntityVector(ctx, n, vector)
  }
  return id
}
/** An open guess from an earlier read: same name and kind, against the same best candidate. */
function pendingGuess(ctx: Context, item: ProposalEntity): string | undefined {
  const best = item.candidates[0]
  if (!best) return undefined
  return all<{ id: string; label: string; kind: string }>(
    ctx,
    `SELECT e.id,e.label,e.kind FROM tidy_suggestions s JOIN entities e ON e.id=s.first_id
    WHERE s.state='open' AND s.kind='same_entity' AND s.source='read' AND s.second_id=?
    AND json_extract(s.detail,'$.kind')='guess' ORDER BY s.created_at`,
    best,
  ).find((row) => row.kind === item.kind && fold(row.label) === fold(item.label))?.id
}
function openGuess(
  ctx: Context,
  id: string,
  candidate: string | undefined,
  jobId: string,
): boolean {
  if (!candidate || !entity(ctx, candidate)) return false
  const detail: BrainTidySuggestionExtra = { kind: 'guess', jobId }
  return insertSuggestion(ctx, {
    key: pairKey('entity', id, candidate),
    kind: 'same_entity',
    first: id,
    second: candidate,
    reason: `A read was unsure whether this is ${entity(ctx, candidate)!.label}; Brain kept it apart.`,
    detail,
  })
}
/** One `group` question per parent and member set; false when Brain already asked it. */
export function openGroup(
  ctx: Context,
  jobId: string,
  parent: { label: string; kind: ProposalEntity['kind']; entityId: string | null },
  memberIds: string[],
): boolean {
  const members = [...new Set(memberIds)].filter((id) => id !== parent.entityId)
  if (members.length < 2) return false
  const key = `group:${createHash('sha256')
    .update(JSON.stringify([[...members].sort(), fold(parent.label)]))
    .digest('hex')}`
  const labels = members.map((id) => entity(ctx, id)!.label)
  const detail: BrainTidySuggestionExtra = { kind: 'group', jobId, parent, memberIds: members }
  return insertSuggestion(ctx, {
    key,
    kind: 'group',
    first: members[0]!,
    second: members[1]!,
    reason: `A read says these may be part of ${parent.label}: ${labels.join(', ')}.`.slice(0, 300),
    detail,
  })
}
function insertSuggestion(
  ctx: Context,
  row: {
    key: string
    kind: 'same_entity' | 'group'
    first: string
    second: string
    reason: string
    detail: BrainTidySuggestionExtra
  },
): boolean {
  if (one(ctx, 'SELECT 1 FROM tidy_suggestions WHERE pair_key=?', row.key)) return false
  const now = ctx.now()
  run(
    ctx,
    `INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,detail,created_at,updated_at)
    VALUES (?,?,?,'read','open','entity',?,?,?,?,?,?)`,
    ctx.id(),
    row.key,
    row.kind,
    row.first,
    row.second,
    row.reason,
    JSON.stringify(row.detail),
    now,
    now,
  )
  return true
}

/** The entity that is you, followed through merges; null once it left Brain. */
export function owner(ctx: Context): string | null {
  const id = one<{ value: string }>(ctx, "SELECT value FROM meta WHERE key='owner_entity'")?.value
  if (!id) return null
  try {
    return survivingEntityId(ctx, id)
  } catch {
    return null
  }
}
export function setOwnerEntity(ctx: Context, id: string | null): void {
  if (id === null) run(ctx, "DELETE FROM meta WHERE key='owner_entity'")
  else {
    entityNumber(ctx, id)
    run(ctx, "INSERT OR REPLACE INTO meta VALUES ('owner_entity', ?)", id)
  }
}
