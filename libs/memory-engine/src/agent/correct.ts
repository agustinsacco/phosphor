import { all, one, run, transaction, type Context } from '../database'
import { reactivatePartners } from '../commit'
import { brainLinks, carryRelations } from '../carry'
import { insertLink, parseLinkInput, type ParsedLink } from './link-input'
import { nextNumber, bumpKnowledgeRevision } from '../prefs'
import { scrubExcerpt } from '../secrets'
import { encodeVector } from '../vectors'
import { journal } from '../tidy/journal'
import { memorySelection } from '../tidy/operations'
import { rebuild } from '../tidy/projections'
import type { BrainChangeNote, BrainCorrection, CorrectResult } from './types'

function text(value: string, max: number, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) throw new Error(`${label} needs 1 to ${max} characters.`)
  const clean = scrubExcerpt(trimmed)
  if (!clean || clean.length > max) throw new Error(`${label} needs 1 to ${max} characters.`)
  return clean
}
export function correct(
  ctx: Context,
  input: BrainCorrection,
  vector: Float32Array | null,
  note: BrainChangeNote,
): CorrectResult {
  const summary = text(input.summary, 1200, 'A corrected memory')
  const source = text(input.source, 120, 'A source')
  const quote = text(input.quote, 1200, 'A quote')
  const encoded = vector ? encodeVector(vector) : null
  return transaction(ctx, () => {
    const old = one<CorrectionTarget>(
      ctx,
      "SELECT * FROM memories WHERE id=? AND state IN ('active','disputed')",
      input.memoryId,
    )
    if (!old) throw new Error('This memory is no longer current.')
    const links = uniqueLinks((input.links ?? []).map((link) => parseLinkInput(ctx, link)))
    const ends = endedRelations(ctx, old.n, input.ends ?? [])
    const selection = memorySelection(ctx, old.n, old.n)
    const label = one<{ label: string }>(
      ctx,
      'SELECT e.label FROM mentions a JOIN entities e ON e.n=a.entity WHERE a.memory=? ORDER BY e.n LIMIT 1',
      old.n,
    )?.label
    const id = ctx.id(),
      now = ctx.now()
    let carry: { carried: number[]; ended: number[] } = { carried: [], ended: [] }
    let n = 0
    const operationId = journal(
      ctx,
      {
        id,
        kind: 'correct',
        note,
        selection,
        subjects: { type: 'memory', first: input.memoryId, second: input.memoryId },
        summary: label ? `Corrected a memory about ${label}` : 'Corrected a memory',
      },
      () => {
        const inserted = insertCorrectedMemory(
          ctx,
          old,
          { summary, source, quote },
          encoded,
          id,
          now,
        )
        n = inserted.n
        for (const link of links)
          insertLink(ctx, n, link, 'agent', [{ evidence: inserted.evidence, quote }])
        carry = carryRelations(ctx, old.n, n, now, ends)
        reactivatePartners(ctx, old.n)
        run(ctx, "UPDATE memories SET state='superseded',valid_to=? WHERE n=?", now, old.n)
        run(ctx, 'UPDATE relations SET live=0 WHERE memory=?', old.n)
        run(ctx, "INSERT INTO memory_links VALUES (?,?,'supersedes',?)", n, old.n, now)
        selection.memories.push(n)
      },
    )
    rebuild(ctx, selection, [])
    bumpKnowledgeRevision(ctx)
    return {
      operationId,
      carried: brainLinks(ctx, relationNumbers(ctx, n)),
      ended: brainLinks(ctx, carry.ended),
    }
  })
}
function relationNumbers(ctx: Context, memory: number): number[] {
  return all<{ n: number }>(ctx, 'SELECT n FROM relations WHERE memory=? ORDER BY n', memory).map(
    (r) => r.n,
  )
}
/** The correction's own links, one per subject, predicate and object. */
function uniqueLinks(links: ParsedLink[]): ParsedLink[] {
  const seen = new Set<string>()
  return links.filter((l) => {
    const key = `${l.subject}|${l.predicate}|${l.object}`
    return !seen.has(key) && !!seen.add(key)
  })
}
function endedRelations(ctx: Context, memory: number, ids: string[]): Set<number> {
  const ends = new Set<number>()
  for (const id of ids) {
    const n = Number(id)
    if (
      !Number.isSafeInteger(n) ||
      !one(ctx, 'SELECT 1 FROM relations WHERE n=? AND memory=?', n, memory)
    )
      throw new Error('A link to end must belong to the memory being corrected.')
    ends.add(n)
  }
  return ends
}

interface CorrectionTarget {
  n: number
  type: string
  epistemic: string
  scope: string
  branch: string | null
}
function insertCorrectedMemory(
  ctx: Context,
  old: CorrectionTarget,
  text: Pick<BrainCorrection, 'summary' | 'source' | 'quote'>,
  encoded: Uint8Array | null,
  id: string,
  now: number,
): { n: number; evidence: number } {
  const { summary, source, quote } = text
  const n = nextNumber(ctx, 'memories')
  run(
    ctx,
    'INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    n,
    ctx.id(),
    summary,
    old.type,
    old.epistemic,
    old.scope,
    old.branch,
    null,
    null,
    now,
    now,
    'active',
    null,
    null,
    null,
  )
  run(ctx, 'INSERT INTO mentions SELECT ?,entity FROM mentions WHERE memory=?', n, old.n)
  run(
    ctx,
    'INSERT INTO evidence(session_id,entry_id,role,label,observed_at,text) VALUES (NULL,?,?,?,?,?)',
    `agent:${id}`,
    'user',
    `Brain Agent, from ${source}`,
    now,
    quote,
  )
  const evidence = one<{ n: number }>(ctx, 'SELECT last_insert_rowid() AS n')!.n
  run(ctx, 'INSERT INTO citations VALUES (?,?,?)', n, evidence, quote)
  if (encoded) run(ctx, 'INSERT INTO memory_vectors VALUES (?,?)', n, encoded)
  return { n, evidence }
}
