import {
  BRAIN_LINK_LABEL_MAX,
  BRAIN_LINK_RULES,
  BRAIN_PREDICATES,
  BRAIN_SYMMETRIC_PREDICATES,
  type BrainPredicate,
  type BrainStatedBy,
} from '@phosphor/shared/brain-links'
import type { BrainLinkInput } from '@phosphor/shared/brain-agent'
import type { BrainEntityKind } from '@phosphor/shared/brain'
import { one, run, type Context } from '../database'
import { scrubExcerpt } from '../secrets'

export interface ParsedLink {
  subject: number
  predicate: BrainPredicate
  object: number
  label: string
  validFrom: number | null
  validTo: number | null
}
const SYMMETRIC = new Set<string>(BRAIN_SYMMETRIC_PREDICATES)

/** A link's wording: 1 to 80 characters on one line, scrubbed like a read's. */
export function linkLabel(value: string): string {
  const label = value.trim().replace(/\s+/gu, ' ')
  const clean = label && scrubExcerpt(label)
  if (!clean || clean.length > BRAIN_LINK_LABEL_MAX)
    throw new Error(`A link's wording needs 1 to ${BRAIN_LINK_LABEL_MAX} characters.`)
  return clean
}
/** YYYY-MM-DD as UTC midnight; null clears; undefined keeps. */
export function linkDate(value: string | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  const at = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN
  if (!match || new Date(at).toISOString().slice(0, 10) !== value)
    throw new Error('A link date needs the form YYYY-MM-DD.')
  return at
}
export function checkPeriod(validFrom: number | null, validTo: number | null): void {
  if (validFrom !== null && validTo !== null && validTo < validFrom)
    throw new Error('A link cannot end before it starts.')
}
function entityRow(ctx: Context, id: string): { n: number; kind: BrainEntityKind } {
  const row = one<{ n: number; kind: BrainEntityKind }>(
    ctx,
    'SELECT n,kind FROM entities WHERE id=?',
    id,
  )
  if (!row) throw new Error('This person or thing is no longer in Brain.')
  return row
}
/** Both ends exist, differ and fit the predicate's kinds; a symmetric link is stored once. */
export function parseLinkInput(ctx: Context, input: BrainLinkInput): ParsedLink {
  if (!BRAIN_PREDICATES.includes(input.predicate)) throw new Error('Unknown link type.')
  const subject = entityRow(ctx, input.subjectId),
    object = entityRow(ctx, input.objectId)
  if (subject.n === object.n) throw new Error('A link joins two different people or things.')
  const rule = BRAIN_LINK_RULES[input.predicate]
  if (!rule.subject.includes(subject.kind) || !rule.object.includes(object.kind))
    throw new Error(`A ${subject.kind} and a ${object.kind} cannot be linked this way.`)
  const validFrom = linkDate(input.since) ?? null,
    validTo = linkDate(input.until) ?? null
  checkPeriod(validFrom, validTo)
  const swap = SYMMETRIC.has(input.predicate) && object.n < subject.n
  return {
    subject: swap ? object.n : subject.n,
    predicate: input.predicate,
    object: swap ? subject.n : object.n,
    label: linkLabel(input.label),
    validFrom,
    validTo,
  }
}
/** Stores a stated link on `memory` with one quote, and mentions of both ends. */
export function insertLink(
  ctx: Context,
  memory: number,
  link: ParsedLink,
  statedBy: BrainStatedBy,
  support: { evidence: number; quote: string }[],
): number {
  run(
    ctx,
    `INSERT INTO relations(memory,subject,predicate,object,live,observed_at,label,valid_from,valid_to,stated_by)
    SELECT ?,?,?,?,state!='superseded',observed_at,?,?,?,? FROM memories WHERE n=?`,
    memory,
    link.subject,
    link.predicate,
    link.object,
    link.label,
    link.validFrom,
    link.validTo,
    statedBy,
    memory,
  )
  const n = one<{ n: number }>(ctx, 'SELECT last_insert_rowid() AS n')!.n
  for (const s of support)
    run(ctx, 'INSERT OR IGNORE INTO relation_support VALUES (?,?,?)', n, s.evidence, s.quote)
  run(
    ctx,
    'INSERT OR IGNORE INTO mentions VALUES (?,?),(?,?)',
    memory,
    link.subject,
    memory,
    link.object,
  )
  return n
}
