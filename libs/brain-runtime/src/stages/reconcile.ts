import type {
  BrainStore,
  ProposalEntity,
  ProposalMemory,
  Citation,
  Proposal,
} from '@phosphor/memory-engine/types'
import type { StageAsk } from '../stage-types'
import type { BrainSearchPort } from '../types'
import { validDecisions, object, text } from '../stage-parse'
import { reconcilePrompt } from '../stage-prompts/reconcile'
import type { FoldedJob } from './fold'
import { type Card, type Row, candidateRows, same } from './reconcile-candidates'

const uniqueCitations = (items: Citation[]): Citation[] => [
  ...new Map(items.map((c) => [`${c.evidence}:${c.quote}`, c])).values(),
]
function decisions(answer: string, rows: Row[]) {
  return validDecisions(answer, (v) => {
    const d = object(v),
      ref = text(d.ref),
      row = rows.find((r) => r.claim.ref === ref)
    if (
      !row ||
      !['add', 'confirm', 'enrich', 'supersede', 'conflict', 'resolve_open'].includes(
        String(d.action),
      )
    )
      throw new Error('Invalid reconciliation action')
    const target =
      d.action === 'add' ? undefined : row.candidates.find((_c, i) => `M${i + 1}` === d.target)
    if (d.action === 'add' ? d.target !== null : !target)
      throw new Error(`Unoffered reconciliation target for ${ref}`)
    if (d.action === 'resolve_open' && target?.type !== 'open')
      throw new Error('resolve_open requires an open target')
    return {
      ref,
      action: d.action as ProposalMemory['action'] | 'confirm',
      target,
      reason: text(d.reason),
    }
  })
}
export async function reconcile(
  job: FoldedJob,
  entities: ProposalEntity[],
  store: BrainStore,
  search: BrainSearchPort,
  vectors: Float32Array[],
  ask: StageAsk,
  excluded: string[] = [],
): Promise<Proposal['confirmations']> {
  const rows = await candidateRows(job, entities, store, search, vectors, excluded)
  const confirmations: Proposal['confirmations'] = [],
    removed = new Set<string>(),
    pending: Row[] = []
  const state = { job, confirmations, removed }
  const selected = new Map<string, ReturnType<typeof decisions>[number]>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!,
      equal = row.candidates.find((c) => same(row.comparison, c))
    if (equal)
      selected.set(row.claim.ref, {
        ref: row.claim.ref,
        action: 'confirm',
        target: equal,
        reason: 'Equal folded text and links',
      })
    else if (row.candidates.length) pending.push(row)
  }
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20)
    const result = await reconcileDecisions(batch, ask, i / 20 + 1)
    for (const d of result) selected.set(d.ref, d)
  }
  // Only state-changing actions compete for a target; confirmations add evidence and never do.
  const winners = new Map<string, ReturnType<typeof decisions>[number]>()
  for (const row of rows) {
    const d = selected.get(row.claim.ref)
    if (!d?.target || d.target.local || d.action === 'confirm') continue
    const previous = winners.get(d.target.id)
    if (!previous || priority(d.action) > priority(previous.action)) winners.set(d.target.id, d)
  }
  for (const row of rows) {
    const d = selected.get(row.claim.ref)
    if (!d) continue
    const winner = d.target && !d.target.local ? winners.get(d.target.id) : undefined
    if (winner && winner !== d) {
      const reason = `Another claim has a higher-priority action on target ${winner.target!.id}`
      if (d.action === 'confirm') {
        removed.add(row.claim.ref)
        job.outcomes.push({
          candidate: row.claim.ref,
          summary: row.claim.memory.summary,
          status: 'dropped',
          reason,
        })
      } else applyDecision(state, row, 'add', undefined, reason)
    } else applyDecision(state, row, d.action, d.target, d.reason)
  }
  job.claims = job.claims.filter((c) => !removed.has(c.ref))
  return confirmations
}

async function reconcileDecisions(batch: Row[], ask: StageAsk, part: number) {
  const result: ReturnType<typeof decisions> = []
  let missing = batch
  for (let attempt = 0; attempt < 2 && missing.length; attempt++) {
    const rows = missing.map((r) => ({
      claim: { ...r.claim, memory: r.comparison },
      candidates: r.candidates.map((c, j) => ({ ...c, handle: `M${j + 1}` })),
    }))
    result.push(
      ...(await ask('reconcile', part, reconcilePrompt(rows), (a) => decisions(a, missing), [], {
        rows,
      })),
    )
    missing = batch.filter((r) => !result.some((d) => d.ref === r.claim.ref))
  }
  result.push(
    ...missing.map((r) => ({
      ref: r.claim.ref,
      action: 'add' as const,
      target: undefined,
      reason: 'No reconciliation decision returned',
    })),
  )
  return result
}

function priority(action: ProposalMemory['action'] | 'confirm'): number {
  return { add: 0, confirm: 1, enrich: 2, conflict: 3, supersede: 4, resolve_open: 4 }[action]
}

function applyDecision(
  {
    job,
    confirmations,
    removed,
  }: {
    job: FoldedJob
    confirmations: Proposal['confirmations']
    removed: Set<string>
  },
  row: Row,
  action: ProposalMemory['action'] | 'confirm',
  target: Card | undefined,
  reason: string,
): void {
  const m = row.claim.memory
  if (target?.local) {
    const previous = job.claims.find((c) => c.ref === target.id)
    if (!previous || removed.has(previous.ref)) return
    if (action === 'confirm' || action === 'enrich') {
      previous.memory.citations = uniqueCitations([...previous.memory.citations, ...m.citations])
      if (action === 'enrich') {
        previous.memory.links.push(...m.links)
        previous.memory.entities = [...new Set([...previous.memory.entities, ...m.entities])]
      }
      removed.add(row.claim.ref)
      job.outcomes.push({
        candidate: row.claim.ref,
        summary: m.summary,
        status: 'folded',
        reason: `merged into ${previous.ref}`,
      })
    } else if (action !== 'add') {
      removed.add(previous.ref)
      job.outcomes.push({
        candidate: previous.ref,
        summary: previous.memory.summary,
        status: 'dropped',
        reason:
          action === 'resolve_open'
            ? 'resolved later in this lane'
            : action === 'conflict'
              ? 'contradicted later in this lane'
              : 'superseded later in this lane',
      })
    }
  } else if (target && action === 'confirm') {
    confirmations.push({ memoryId: target.id, claim: structuredClone(m), vector: row.vector })
    removed.add(row.claim.ref)
    job.outcomes.push({
      candidate: row.claim.ref,
      summary: m.summary,
      status: 'reconfirms',
      memoryId: target.id,
    })
  } else {
    m.action = action === 'confirm' ? 'add' : action
    m.target = target?.id ?? null
    m.reason = reason
  }
}
