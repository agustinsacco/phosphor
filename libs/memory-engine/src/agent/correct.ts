import { one, run, transaction, type Context } from '../database'
import { reactivatePartners } from '../commit'
import { nextNumber, bumpKnowledgeRevision } from '../prefs'
import { scrubExcerpt } from '../secrets'
import { encodeVector } from '../vectors'
import { journal } from '../tidy/journal'
import { memorySelection } from '../tidy/operations'
import { rebuild } from '../tidy/projections'
import type { BrainChangeNote, BrainCorrection } from './types'

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
): string {
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
    const selection = memorySelection(ctx, old.n, old.n)
    const label = one<{ label: string }>(
      ctx,
      'SELECT e.label FROM mentions a JOIN entities e ON e.n=a.entity WHERE a.memory=? ORDER BY e.n LIMIT 1',
      old.n,
    )?.label
    const id = ctx.id(),
      now = ctx.now()
    const operation = journal(
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
        const n = insertCorrectedMemory(ctx, old, { summary, source, quote }, encoded, id, now)
        reactivatePartners(ctx, old.n)
        run(ctx, "UPDATE memories SET state='superseded',valid_to=? WHERE n=?", now, old.n)
        run(ctx, 'UPDATE relations SET live=0 WHERE memory=?', old.n)
        run(ctx, "INSERT INTO memory_links VALUES (?,?,'supersedes',?)", n, old.n, now)
        selection.memories.push(n)
      },
    )
    rebuild(ctx, selection, [])
    bumpKnowledgeRevision(ctx)
    return operation
  })
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
): number {
  const { summary, source, quote } = text
  const n = nextNumber(ctx, 'memories')
  run(
    ctx,
    'INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
  return n
}
