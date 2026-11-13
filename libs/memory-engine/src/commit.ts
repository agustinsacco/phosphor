import { all, one, run, type Context } from './database'
import { adjustCount, entityNumber } from './entities'
import { encodeBits } from './bits'
import { nextNumber } from './prefs'
import { memoryNumber } from './knowledge'
import { scrubExcerpt } from './secrets'
import { encodeVector } from './vectors'
import type { Citation, EvidenceExcerpt, Proposal, ProposalMemory } from './types'

export interface CommitContext {
  ctx: Context
  proposal: Proposal
  resolve: (ref: string) => string
  evidence: Map<number, number>
  touched: Set<number>
}
export function insertEvidence(commit: CommitContext, index: number): number {
  const cached = commit.evidence.get(index)
  if (cached !== undefined) return cached
  const { ctx, proposal } = commit
  const e = proposal.evidence[index]!
  const clean = scrubExcerpt(e.text)
  let n = one<{ n: number }>(
    ctx,
    'SELECT n FROM evidence WHERE session_id=? AND entry_id=? AND text=? LIMIT 1',
    e.sessionId,
    e.entryId,
    clean,
  )?.n
  if (n === undefined)
    n = Number(
      ctx.db
        .prepare(
          'INSERT INTO evidence(session_id,entry_id,role,label,observed_at,text) VALUES (?,?,?,?,?,?)',
        )
        .run(e.sessionId, e.entryId, e.role, scrubExcerpt(e.label), e.observedAt, clean)
        .lastInsertRowid,
    )
  commit.evidence.set(index, n)
  return n
}
export function insertCitations(
  commit: CommitContext,
  memory: number,
  citations: Citation[],
): void {
  const { ctx, proposal } = commit
  for (const c of citations) {
    const excerpt = proposal.evidence[c.evidence]!
    const quote = scrubExcerpt(c.quote)
    if (
      !one(
        ctx,
        'SELECT 1 FROM citations c JOIN evidence e ON e.n=c.evidence WHERE c.memory=? AND e.entry_id=? AND c.quote=? LIMIT 1',
        memory,
        excerpt.entryId,
        quote,
      )
    )
      run(
        ctx,
        'INSERT OR IGNORE INTO citations VALUES (?,?,?)',
        memory,
        insertEvidence(commit, c.evidence),
        quote,
      )
    run(
      ctx,
      'UPDATE memories SET observed_at=MAX(observed_at,?) WHERE n=?',
      excerpt.observedAt,
      memory,
    )
  }
  run(
    ctx,
    'UPDATE relations SET observed_at=(SELECT observed_at FROM memories WHERE n=?) WHERE memory=?',
    memory,
    memory,
  )
}
function observed(item: ProposalMemory, evidence: EvidenceExcerpt[], fallback: number): number {
  return (
    Math.max(
      0,
      ...[...item.citations, ...item.links.map((link) => link.citation)].map(
        (c) => evidence[c.evidence]!.observedAt,
      ),
    ) || fallback
  )
}
function insertRow(
  commit: CommitContext,
  item: ProposalMemory,
  vector: Float32Array | undefined,
): { id: string; n: number } {
  const { ctx, proposal } = commit
  const id = ctx.id()
  const n = nextNumber(ctx, 'memories')
  run(
    ctx,
    `INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    n,
    id,
    scrubExcerpt(item.summary),
    item.type,
    item.kind,
    proposal.scope,
    item.branch ? proposal.branch : null,
    item.validFrom,
    item.validTo,
    observed(item, proposal.evidence, ctx.now()),
    ctx.now(),
    'active',
    proposal.origin.sessionId,
    scrubExcerpt(proposal.origin.title),
    proposal.jobId,
  )
  run(ctx, 'INSERT INTO memory_words(rowid,summary) VALUES (?,?)', n, scrubExcerpt(item.summary))
  if (vector) {
    run(ctx, 'INSERT INTO memory_vectors VALUES (?,?)', n, encodeVector(vector))
    run(ctx, 'INSERT INTO memory_bits VALUES (?,?)', n, encodeBits(vector))
  }
  adjustCount(ctx, 'memories', 1)
  return { id, n }
}
export function addLinks(commit: CommitContext, memory: number, item: ProposalMemory): void {
  const { ctx, resolve, touched } = commit
  const ids = [...item.entities, ...item.links.flatMap((link) => [link.subject, link.object])]
  for (const ref of new Set(ids)) {
    const n = entityNumber(ctx, resolve(ref))
    touched.add(n)
    run(ctx, 'INSERT OR IGNORE INTO mentions VALUES (?,?)', memory, n)
  }
  for (const link of item.links) {
    const subject = entityNumber(ctx, resolve(link.subject))
    const object = entityNumber(ctx, resolve(link.object))
    if (subject === object) continue
    run(
      ctx,
      'INSERT OR IGNORE INTO relations(memory,subject,predicate,object,live,observed_at) SELECT ?,?,?,?,1,observed_at FROM memories WHERE n=?',
      memory,
      subject,
      link.predicate,
      object,
      memory,
    )
    const relation = one<{ n: number }>(
      ctx,
      'SELECT n FROM relations WHERE memory=? AND subject=? AND predicate=? AND object=?',
      memory,
      subject,
      link.predicate,
      object,
    )!.n
    run(
      ctx,
      'INSERT OR IGNORE INTO relation_support VALUES (?,?,?)',
      relation,
      insertEvidence(commit, link.citation.evidence),
      scrubExcerpt(link.citation.quote),
    )
  }
  insertCitations(commit, memory, [...item.citations, ...item.links.map((link) => link.citation)])
}
export function reactivatePartners(ctx: Context, n: number): void {
  const partners = all<{ n: number }>(
    ctx,
    `SELECT CASE WHEN source=? THEN target ELSE source END AS n FROM memory_links WHERE kind='conflicts' AND (source=? OR target=?)`,
    n,
    n,
    n,
  )
  run(ctx, "DELETE FROM memory_links WHERE kind='conflicts' AND (source=? OR target=?)", n, n)
  for (const partner of partners)
    run(
      ctx,
      `UPDATE memories SET state='active' WHERE n=? AND state='disputed' AND NOT EXISTS(SELECT 1 FROM memory_links WHERE kind='conflicts' AND (source=? OR target=?))`,
      partner.n,
      partner.n,
      partner.n,
    )
}
export function applyMemory(
  commit: CommitContext,
  item: ProposalMemory,
  vector?: Float32Array,
): string {
  const { ctx } = commit
  const current =
    item.action === 'enrich'
      ? { n: memoryNumber(ctx, item.target!), id: item.target! }
      : insertRow(commit, item, vector)
  addLinks(commit, current.n, item)
  if (item.target && item.action !== 'enrich') {
    const target = memoryNumber(ctx, item.target)
    for (const row of all<{ entity: number }>(
      ctx,
      'SELECT entity FROM mentions WHERE memory=?',
      target,
    ))
      commit.touched.add(row.entity)
    if (item.action === 'conflict')
      run(ctx, "UPDATE memories SET state='disputed' WHERE n IN (?,?)", current.n, target)
    else {
      reactivatePartners(ctx, target)
      run(
        ctx,
        "UPDATE memories SET state='superseded',valid_to=? WHERE n=?",
        item.validFrom ?? ctx.now(),
        target,
      )
      run(ctx, 'UPDATE relations SET live=0 WHERE memory=?', target)
      run(ctx, 'DELETE FROM memory_words WHERE rowid=?', target)
      adjustCount(ctx, 'memories', -1)
    }
    run(
      ctx,
      'INSERT OR IGNORE INTO memory_links VALUES (?,?,?,?)',
      current.n,
      target,
      item.action === 'conflict'
        ? 'conflicts'
        : item.action === 'resolve_open'
          ? 'resolves'
          : 'supersedes',
      ctx.now(),
    )
  }
  return current.id
}
