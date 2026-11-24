import type {
  BrainStore,
  MemoryCard,
  ProposalEntity,
  ProposalMemory,
} from '@phosphor/memory-engine/types'
import { cosine } from '@phosphor/memory-engine/vectors'
import { fold } from '@phosphor/memory-engine/text'
import type { BrainSearchPort } from '../types'
import { type FoldedClaim, type FoldedJob, linkKey } from './fold'

/** How many earlier memories and claims one claim is compared with. */
const OFFERED = 5
/** Cosine at which a memory counts as saying something close, whatever it names. */
const SEMANTIC = 0.7

export interface Card {
  id: string
  summary: string
  type: string
  links: { subject: string; predicate: string; object: string }[]
  local: boolean
  /** Superseded: offered only so a claim that repeats it can be dropped. */
  replaced?: true
}
export interface Row {
  claim: FoldedClaim
  vector: Float32Array
  comparison: ProposalMemory
  candidates: Card[]
}
interface Ranked {
  card: Card
  similarity: number
}
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
    ...(memory.state === 'superseded' ? { replaced: true as const } : {}),
  }
}
/**
 * The same whole link (subject, predicate and object), or two owners of one thing, which may
 * replace each other. `uses(Harbor, Ledger)` is not evidence for `depends_on(Harbor, Ledger)`.
 */
function sharesLink(claim: Pick<Card, 'links'>, other: Pick<Card, 'links'>): boolean {
  return claim.links.some((l) =>
    other.links.some(
      (o) =>
        l.predicate === o.predicate &&
        l.object === o.object &&
        (l.subject === o.subject || l.predicate === 'owns'),
    ),
  )
}
/** Same folded text and links: reconcile confirms it without asking. */
export function same(memory: Pick<Card, 'summary' | 'links'>, other: Card): boolean {
  return fold(memory.summary) === fold(other.summary) && linkKey(memory) === linkKey(other)
}
/**
 * Evidence strength, strongest first: an exact duplicate, the same text, a shared link, a close
 * meaning, then only a shared entity. Within a tier the more similar wins.
 */
function strength(claim: ProposalMemory, item: Ranked): number {
  if (same(claim, item.card)) return 4
  if (fold(item.card.summary) === fold(claim.summary)) return 3
  if (sharesLink(claim, item.card)) return 2
  return item.similarity >= SEMANTIC ? 1 : 0
}
export function rankCandidates(claim: ProposalMemory, items: Ranked[]): Card[] {
  return items
    .map((item, order) => ({ ...item, order, tier: strength(claim, item) }))
    .sort((a, b) => b.tier - a.tier || b.similarity - a.similarity || a.order - b.order)
    .slice(0, OFFERED)
    .map((item) => item.card)
}
/** Earlier claims of this job, latest first, that share something with the claim at `index`. */
function earlierClaims(
  job: FoldedJob,
  normalized: ProposalMemory[],
  vectors: Float32Array[],
  index: number,
): Ranked[] {
  const later = normalized[index]!
  return job.claims
    .slice(0, index)
    .map((c, j) => ({ c, m: normalized[j]!, similarity: cosine(vectors[j]!, vectors[index]!) }))
    .reverse()
    .filter(
      ({ m, similarity }) =>
        similarity >= SEMANTIC ||
        fold(m.summary) === fold(later.summary) ||
        sharesLink(later, m) ||
        m.entities.some((e) => later.entities.includes(e)),
    )
    .map(({ c, m, similarity }) => ({
      card: { id: c.ref, summary: m.summary, type: m.type, links: m.links, local: true },
      similarity,
    }))
}
/**
 * Each claim's candidates: stored memories found by link, entity or meaning (cosine 0.7 or more),
 * replaced ones that are very close, and earlier claims of this job, ranked together by evidence
 * strength.
 */
export async function candidateRows(
  job: FoldedJob,
  entities: ProposalEntity[],
  store: BrainStore,
  search: BrainSearchPort,
  vectors: Float32Array[],
  excluded: string[],
  now: number,
): Promise<Row[]> {
  const normalized = job.claims.map((c) => resolvedMemory(c.memory, entities))
  const matches = store.memoryMatches(
    normalized.map((m, i) => ({
      entityIds: m.entities,
      links: m.links.map((l) => ({
        subjectId: l.subject,
        predicate: l.predicate,
        objectId: l.object,
      })),
      vector: vectors[i],
    })),
    OFFERED,
  )
  const semantic = (await search.nearestMemories(vectors, OFFERED)).map((hits) =>
    hits.filter((hit) => hit.score >= SEMANTIC),
  )
  const old = new Map(
    store
      .memoryCards([
        ...new Set([...matches.flat().map((m) => m.id), ...semantic.flat().map((m) => m.id)]),
      ])
      .filter((m) => !excluded.includes(m.id) && (m.validTo === null || m.validTo > now))
      .map((m) => [m.id, card(m)]),
  )
  return job.claims.map((claim, index): Row => {
    const similarity = new Map<string, number>()
    for (const { id, score } of [
      ...(matches[index] ?? []).map((m) => ({ id: m.id, score: m.similarity })),
      ...(semantic[index] ?? []),
    ])
      similarity.set(id, Math.max(similarity.get(id) ?? -1, score))
    const stored = [...similarity].flatMap(([id, score]) =>
      old.has(id) ? [{ card: old.get(id)!, similarity: score }] : [],
    )
    const comparison = normalized[index]!
    return {
      claim,
      comparison,
      vector: vectors[index]!,
      candidates: rankCandidates(comparison, [
        ...stored,
        ...earlierClaims(job, normalized, vectors, index),
      ]),
    }
  })
}
