import type {
  BrainStore,
  MemoryCard,
  ProposalEntity,
  ProposalMemory,
  Citation,
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
): Promise<{ memoryId: string; citations: Citation[] }[]> {
  const rows = await candidateRows(job, entities, store, search, vectors)
  const confirmations: { memoryId: string; citations: Citation[] }[] = [],
    removed = new Set<string>(),
    pending: Row[] = []
  const state = { job, confirmations, removed }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!,
      equal = row.candidates.find((c) => same(row.comparison, c))
    if (equal) applyDecision(state, row, 'confirm', equal, 'Equal folded text and links')
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
    for (const d of result.sort(
      (a, b) =>
        batch.findIndex((r) => r.claim.ref === a.ref) -
        batch.findIndex((r) => r.claim.ref === b.ref),
    ))
      applyDecision(
        state,
        batch.find((r) => r.claim.ref === d.ref)!,
        d.action,
        d.target,
        d.reason,
      )
  }
  job.claims = job.claims.filter((c) => !removed.has(c.ref))
  return confirmations
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
    const prior = job.claims
      .slice(0, index)
      .filter(
        (_c, j) =>
          normalized[j]!.entities.some((e) => normalized[index]!.entities.includes(e)) ||
          fold(normalized[j]!.summary) === fold(normalized[index]!.summary),
      )
      .slice(-5)
      .map((c) => {
        const m = normalized[job.claims.indexOf(c)]!
        return { id: c.ref, summary: m.summary, type: m.type, links: m.links, local: true }
      })
    return {
      claim,
      comparison: normalized[index]!,
      candidates: [...ids.flatMap((id) => (old.has(id) ? [old.get(id)!] : [])), ...prior].slice(
        0,
        5,
      ),
    }
  })
}
function applyDecision(
  {
    job,
    confirmations,
    removed,
  }: {
    job: FoldedJob
    confirmations: { memoryId: string; citations: Citation[] }[]
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
            : 'superseded later in this lane',
      })
    }
  } else if (target && action === 'confirm') {
    confirmations.push({ memoryId: target.id, citations: m.citations })
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
