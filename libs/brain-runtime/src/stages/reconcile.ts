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
import { reconcilePrompt, SUPERSEDE_CORRECTION } from '../stage-prompts/reconcile'
import type { FoldedJob } from './fold'
import { type Card, type Row, candidateRows, same } from './reconcile-candidates'

const uniqueCitations = (items: Citation[]): Citation[] => [
  ...new Map(items.map((c) => [`${c.evidence}:${c.quote}`, c])).values(),
]
/** `repeats_replaced`: the claim says again what a replaced memory said, so it is dropped. */
type Action = ProposalMemory['action'] | 'confirm' | 'repeats_replaced'
const ACTIONS: readonly Action[] = [
  'add',
  'confirm',
  'enrich',
  'supersede',
  'conflict',
  'resolve_open',
  'repeats_replaced',
]
const REPEATS_REPLACED = 'Repeats a memory that was replaced earlier'
function decisions(answer: string, rows: Row[]) {
  return validDecisions(answer, (v) => {
    const d = object(v),
      ref = text(d.ref),
      row = rows.find((r) => r.claim.ref === ref)
    if (!row || !ACTIONS.includes(d.action as Action))
      throw new Error('Invalid reconciliation action')
    const target =
      d.action === 'add' ? undefined : row.candidates.find((_c, i) => `M${i + 1}` === d.target)
    if (d.action === 'add' ? d.target !== null : !target)
      throw new Error(`Unoffered reconciliation target for ${ref}`)
    if (d.action === 'resolve_open' && target?.type !== 'open')
      throw new Error('resolve_open requires an open target')
    if (Boolean(target?.replaced) !== (d.action === 'repeats_replaced'))
      throw new Error('Only repeats_replaced targets a replaced memory')
    return { ref, action: d.action as Action, target, reason: text(d.reason) }
  })
}
/** Same text and links as a current memory confirms it; as only a replaced one, repeats it. */
function deterministic(row: Row): ReturnType<typeof decisions>[number] | undefined {
  const equal = (replaced: boolean) =>
    row.candidates.find((c) => Boolean(c.replaced) === replaced && same(row.comparison, c))
  const current = equal(false),
    replaced = equal(true)
  if (current)
    return {
      ref: row.claim.ref,
      action: 'confirm',
      target: current,
      reason: 'Equal folded text and links',
    }
  if (replaced)
    return {
      ref: row.claim.ref,
      action: 'repeats_replaced',
      target: replaced,
      reason: 'Equal folded text and links',
    }
  return undefined
}
export async function reconcile(
  job: FoldedJob,
  entities: ProposalEntity[],
  store: BrainStore,
  search: BrainSearchPort,
  vectors: Float32Array[],
  ask: StageAsk,
  excluded: string[] = [],
  now = Date.now(),
): Promise<Proposal['confirmations']> {
  const rows = await candidateRows(job, entities, store, search, vectors, excluded, now)
  const confirmations: Proposal['confirmations'] = [],
    removed = new Set<string>(),
    pending: Row[] = []
  const state = { job, confirmations, removed }
  const selected = new Map<string, ReturnType<typeof decisions>[number]>()
  for (const row of rows) {
    const equal = deterministic(row)
    if (equal) selected.set(row.claim.ref, equal)
    else if (row.candidates.length) pending.push(row)
  }
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20)
    const result = await reconcileDecisions(batch, ask, i / 20 + 1)
    for (const d of result) selected.set(d.ref, d)
  }
  await recheckReplacing(pending, selected, ask, job)
  // Only state-changing actions compete for a target; confirmations add evidence and never do.
  const winners = new Map<string, ReturnType<typeof decisions>[number]>()
  for (const row of rows) {
    const d = selected.get(row.claim.ref)
    if (!d?.target || d.target.local || d.target.replaced || d.action === 'confirm') continue
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

/** The hold is left out: reconcile does not use it, and an unchanged prompt reuses its answer. */
const promptRow = ({ claim, comparison: { hold: _hold, ...memory }, candidates }: Row) => ({
  claim: { ...claim, memory },
  candidates: candidates.map((c, j) => ({ ...c, handle: `M${j + 1}` })),
})
const NO_DECISION = 'No reconciliation decision returned'
async function reconcileDecisions(batch: Row[], ask: StageAsk, part: number) {
  const result: ReturnType<typeof decisions> = []
  let missing = batch
  for (let attempt = 0; attempt < 2 && missing.length; attempt++) {
    const rows = missing.map(promptRow)
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
      reason: NO_DECISION,
    })),
  )
  return result
}
/** A claim whose own sentence says it changes something earlier. */
const SAYS_REPLACES = /\b(?:supersed(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|no longer)\b/i
/**
 * A claim that says it supersedes, replaces or no longer holds something, answered add while
 * something it could replace was offered, is asked about once more. The correction rides on its
 * prompt row, so the record rebuilds the prompt like any other.
 */
async function recheckReplacing(
  pending: Row[],
  selected: Map<string, ReturnType<typeof decisions>[number]>,
  ask: StageAsk,
  job: FoldedJob,
): Promise<void> {
  const doubtful = pending.filter((row) => {
    const d = selected.get(row.claim.ref)
    return (
      d?.action === 'add' &&
      d.reason !== NO_DECISION &&
      SAYS_REPLACES.test(row.comparison.summary) &&
      row.candidates.some((c) => !c.replaced)
    )
  })
  const first = Math.ceil(pending.length / 20) + 1
  for (let i = 0; i < doubtful.length; i += 20) {
    const batch = doubtful.slice(i, i + 20)
    const rows = batch.map((r) => ({ ...promptRow(r), correction: SUPERSEDE_CORRECTION }))
    const answers = await ask(
      'reconcile',
      first + i / 20,
      reconcilePrompt(rows),
      (a) => decisions(a, batch),
      [],
      { rows },
    )
    for (const d of answers) if (d.action !== 'add') selected.set(d.ref, d)
    for (const row of batch)
      if (selected.get(row.claim.ref)?.action === 'add')
        job.outcomes.push({
          candidate: `${row.claim.ref}:supersede`,
          summary: row.claim.memory.summary,
          status: 'noted',
          reason:
            'Its sentence says it replaces something, but asked twice, reconcile found nothing it replaces.',
        })
  }
}

function priority(action: Action): number {
  return {
    add: 0,
    repeats_replaced: 0,
    confirm: 1,
    enrich: 2,
    conflict: 3,
    supersede: 4,
    resolve_open: 4,
  }[action]
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
  action: Action,
  target: Card | undefined,
  reason: string,
): void {
  const m = row.claim.memory
  if (action === 'repeats_replaced') {
    removed.add(row.claim.ref)
    job.outcomes.push({
      candidate: row.claim.ref,
      summary: m.summary,
      status: 'dropped',
      reason: REPEATS_REPLACED,
    })
  } else if (target?.local) {
    const previous = job.claims.find((c) => c.ref === target.id)
    if (!previous || removed.has(previous.ref)) return
    if ((previous.memory.hold ?? null) !== (m.hold ?? null)) return
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
