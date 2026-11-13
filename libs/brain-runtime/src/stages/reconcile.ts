import type {
  BrainStore,
  MemoryCard,
  ProposalEntity,
  ProposalMemory,
  Citation,
  Proposal,
} from '@phosphor/memory-engine/types'
import type { StageAsk } from '../stage-types'
import type { BrainSearchPort } from '../types'
import { array, object, jsonAnswer, text } from '../stage-parse'
import { reconcilePrompt } from '../stage-prompts/reconcile'
import { type FoldedJob, type FoldedClaim, linkKey } from './fold'
import { fold } from '@phosphor/memory-engine/text'

interface Card {
  id: string
  summary: string
  type: string
  links: { subject: string; predicate: string; object: string }[]
  local: boolean
}
interface Row {
  claim: FoldedClaim
  vector: Float32Array
  comparison: ProposalMemory
  candidates: Card[]
}
const uniqueCitations = (items: Citation[]): Citation[] => [
  ...new Map(items.map((c) => [`${c.evidence}:${c.quote}`, c])).values(),
]
function resolvedMemory(memory: ProposalMemory, entities: ProposalEntity[]): ProposalMemory {
  const resolve = (id: string): string => entities.find((e) => e.ref === id)?.entityId ?? id
  return {
    ...memory,
    entities: memory.entities.map(resolve),
    links: memory.links.map((l) => ({
      ...l,
      subject: resolve(l.subject),
      object: resolve(l.object),
    })),
  }
}
function card(memory: MemoryCard): Card {
  return {
    id: memory.id,
    summary: memory.summary,
    type: memory.type,
    local: false,
    links: memory.links.map((l) => ({
      subject: l.subjectId,
      predicate: l.predicate,
      object: l.objectId,
    })),
  }
}
function same(memory: ProposalMemory, other: Card): boolean {
  return fold(memory.summary) === fold(other.summary) && linkKey(memory) === linkKey(other)
}
function decisions(answer: string, rows: Row[]) {
  const items = array(jsonAnswer(answer).decisions).map((v) => {
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
  if (items.length !== rows.length || new Set(items.map((d) => d.ref)).size !== rows.length)
    throw new Error('Expected one reconciliation decision per claim')
  return items
}
export async function reconcile(
  job: FoldedJob,
  entities: ProposalEntity[],
  store: BrainStore,
  search: BrainSearchPort,
  vectors: Float32Array[],
  ask: StageAsk,
): Promise<Proposal['confirmations']> {
  const rows = await candidateRows(job, entities, store, search, vectors)
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
    const rows = batch.map((r) => ({
      claim: { ...r.claim, memory: r.comparison },
      candidates: r.candidates.map((c, j) => ({ ...c, handle: `M${j + 1}` })),
    }))
    const result = await ask(
      'reconcile',
      i / 20 + 1,
      reconcilePrompt(rows),
      (a) => decisions(a, batch),
      [],
      { rows },
    )
    for (const d of result) selected.set(d.ref, d)
  }
  const winners = new Map<string, ReturnType<typeof decisions>[number]>()
  for (const row of rows) {
    const d = selected.get(row.claim.ref)
    if (!d?.target || d.target.local) continue
    const previous = winners.get(d.target.id)
    if (!previous || priority(d.action) > priority(previous.action)) winners.set(d.target.id, d)
  }
  for (const row of rows) {
    const d = selected.get(row.claim.ref)
    if (!d) continue
    if (d.target && !d.target.local && winners.get(d.target.id) !== d) {
      const reason = `Another claim has a higher-priority action on target ${d.target.id}`
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

function priority(action: ProposalMemory['action'] | 'confirm'): number {
  return { add: 0, confirm: 1, enrich: 2, conflict: 3, supersede: 4, resolve_open: 4 }[action]
}

async function candidateRows(
  job: FoldedJob,
  entities: ProposalEntity[],
  store: BrainStore,
  search: BrainSearchPort,
  vectors: Float32Array[],
): Promise<Row[]> {
  const normalized = job.claims.map((c) => resolvedMemory(c.memory, entities))
  const matches = store.memoryMatches(
    normalized.map((m) => ({
      entityIds: m.entities,
      links: m.links.map((l) => ({
        subjectId: l.subject,
        predicate: l.predicate,
        objectId: l.object,
      })),
    })),
    5,
  )
  const semantic = await search.nearestMemories(vectors, 5)
  const old = new Map(
    store
      .memoryCards([
        ...new Set([
          ...matches.flat(),
          ...semantic.flatMap((m) => m.filter((v) => v.score >= 0.8).map((v) => v.id)),
        ]),
      ])
      .map((m) => [m.id, card(m)]),
  )
  return job.claims.map((claim, index): Row => {
    const ids = [
      ...new Set([
        ...(matches[index] ?? []),
        ...(semantic[index] ?? []).filter((m) => m.score >= 0.8).map((m) => m.id),
      ]),
    ]
    const comparison = normalized[index]!
    const prior = job.claims
      .slice(0, index)
      .map((c, j) => ({ c, m: normalized[j]!, rank: closeness(normalized[j]!, comparison), j }))
      .filter((item) => item.rank >= 0)
      .sort((a, b) => b.rank - a.rank || b.j - a.j)
      .slice(0, 5)
      .map(({ c, m }) => ({
        id: c.ref,
        summary: m.summary,
        type: m.type,
        links: m.links,
        local: true,
      }))
    const offered = [...ids.flatMap((id) => (old.has(id) ? [old.get(id)!] : [])), ...prior]
    // An exact duplicate is always offered, so the deterministic fold or confirm can see it.
    const equal = offered.filter((card) => same(comparison, card))
    return {
      claim,
      comparison,
      vector: vectors[index]!,
      candidates: [...equal, ...offered.filter((card) => !equal.includes(card))].slice(0, 5),
    }
  })
}
/**
 * How close an earlier claim in this job is to a later one: the same text, then a shared link
 * between the same entities, then any shared entity. Unrelated claims are -1 and never offered.
 */
function closeness(earlier: ProposalMemory, later: ProposalMemory): number {
  if (fold(earlier.summary) === fold(later.summary)) return 3
  const pairs = new Set(later.links.map((l) => `${l.subject}|${l.object}`))
  if (earlier.links.some((l) => pairs.has(`${l.subject}|${l.object}`))) return 2
  if (earlier.entities.some((e) => later.entities.includes(e))) return 1
  return -1
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
