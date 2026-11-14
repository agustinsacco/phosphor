import type { BrainExtractionOutcome } from '@phosphor/shared/brain'
import type { EvidenceExcerpt, ProposalMemory } from '@phosphor/memory-engine/types'
import type { ExtractedPart, StageEntity, StageParent } from '../stage-types'
import { fold, tokens } from '@phosphor/memory-engine/text'
import { scrubExcerpt } from '@phosphor/memory-engine/secrets'

export interface FoldedClaim {
  ref: string
  memory: ProposalMemory
}
export interface FoldedJob {
  entities: StageEntity[]
  claims: FoldedClaim[]
  evidence: EvidenceExcerpt[]
  parents: StageParent[]
  outcomes: BrainExtractionOutcome[]
}
export function redirect(id: string, redirects: Map<string, string>): string {
  const seen = new Set<string>()
  while (redirects.has(id) && !seen.has(id)) {
    seen.add(id)
    id = redirects.get(id)!
  }
  return id
}
export function rewriteMemory(
  memory: ProposalMemory,
  redirects: Map<string, string>,
): ProposalMemory {
  const links = memory.links
    .map((l) => ({
      ...l,
      subject: redirect(l.subject, redirects),
      object: redirect(l.object, redirects),
    }))
    .filter((l) => l.subject !== l.object)
  return {
    ...memory,
    entities: [...new Set(memory.entities.map((id) => redirect(id, redirects)))],
    links,
  }
}
export function rewriteClaim(
  claim: FoldedClaim,
  redirects: Map<string, string>,
  outcomes: BrainExtractionOutcome[],
): FoldedClaim {
  claim.memory.links.forEach((link, index) => {
    if (redirect(link.subject, redirects) !== redirect(link.object, redirects)) return
    outcomes.push({
      candidate: `${claim.ref}:link:${index + 1}`,
      summary: `${link.subject} ${link.predicate} ${link.object}`,
      status: 'dropped',
      reason: 'Identity folding made both link endpoints the same entity',
    })
  })
  return { ...claim, memory: rewriteMemory(claim.memory, redirects) }
}
export function mergeEntity(target: StageEntity, source: StageEntity): void {
  target.aliases = [...new Set([...target.aliases, source.label, ...source.aliases])].filter(
    (name) => fold(name) !== fold(target.label),
  )
  target.keys = [
    ...new Map(
      [...target.keys, ...source.keys].map((k) => [`${k.namespace}:${k.value}`, k]),
    ).values(),
  ]
  target.description ||= source.description
}
export function sameEntity(a: StageEntity, b: StageEntity): boolean {
  if (
    a.keys.some((k) =>
      b.keys.some((other) => k.namespace === other.namespace && k.value !== other.value),
    )
  )
    return false
  const matching = [a.label, ...a.aliases]
    .map(fold)
    .filter((name) => [b.label, ...b.aliases].some((n) => fold(n) === name))
  return matching.some(
    (name) => (a.kind !== 'person' && b.kind !== 'person') || tokens(name).length >= 2,
  )
}
export function linkKey(memory: {
  links: { subject: string; predicate: string; object: string }[]
}): string {
  return [...new Set(memory.links.map((l) => `${l.subject}|${l.predicate}|${l.object}`))]
    .sort()
    .join(';')
}
export function claimKey(memory: ProposalMemory): string {
  return `${fold(memory.summary)}|${linkKey(memory)}`
}

export function foldParts(parts: ExtractedPart[], sessionId: string): FoldedJob {
  const job: FoldedJob = { entities: [], claims: [], evidence: [], parents: [], outcomes: [] }
  const redirects = new Map<string, string>()
  for (const part of parts) {
    job.outcomes.push(...(part.extraction.outcomes ?? []))
    for (const entity of part.extraction.entities) {
      const target = job.entities.find((e) => sameEntity(e, entity))
      if (target) {
        redirects.set(entity.ref, target.ref)
        mergeEntity(target, entity)
        job.outcomes.push({
          candidate: entity.ref,
          summary: entity.label,
          status: 'folded',
          reason: `Same full name/alias as ${target.ref}, without contradictory keys`,
        })
      } else job.entities.push(structuredClone(entity))
    }
    appendClaims(job, part, sessionId)
    job.parents.push(...part.extraction.parents)
  }
  job.parents = job.parents.map((p) => ({ ...p, entity: redirect(p.entity, redirects) }))
  const byKey = new Map<string, FoldedClaim>()
  for (const claim of job.claims) {
    claim.memory = rewriteClaim(claim, redirects, job.outcomes).memory
    const previous = byKey.get(claimKey(claim.memory))
    if (!previous) {
      byKey.set(claimKey(claim.memory), claim)
      continue
    }
    previous.memory.citations = uniqueCitations([
      ...previous.memory.citations,
      ...claim.memory.citations,
    ])
    previous.memory.links.push(...claim.memory.links)
    job.outcomes.push({
      candidate: claim.ref,
      summary: claim.memory.summary,
      status: 'folded',
      reason: `Equal text and links as ${previous.ref}`,
    })
  }
  job.claims = [...byKey.values()]
  return job
}
function uniqueCitations<T extends { evidence: number; quote: string }>(citations: T[]): T[] {
  return [...new Map(citations.map((c) => [`${c.evidence}:${c.quote}`, c])).values()]
}
function appendClaims(job: FoldedJob, part: ExtractedPart, sessionId: string): void {
  const citation = (q: { segment: string; quote: string }) => {
    const segment = part.window.segments[Number(q.segment.slice(1)) - 1]!
    let evidence = job.evidence.findIndex(
      (e) => e.entryId === segment.entryId && e.text.includes(q.quote),
    )
    if (evidence < 0) {
      const start = segment.text.indexOf(q.quote)
      evidence = job.evidence.length
      job.evidence.push({
        ...segment,
        sessionId,
        text: scrubExcerpt(segment.text, Math.max(0, start - 400), start + q.quote.length + 400),
      })
    }
    return { evidence, quote: scrubExcerpt(q.quote) }
  }
  for (const c of part.extraction.claims)
    job.claims.push({
      ref: c.ref,
      memory: {
        summary: scrubExcerpt(c.text),
        type: c.type,
        kind: c.epistemic,
        entities: c.mentions,
        links: c.links.map((l) => ({
          subject: l.subject,
          predicate: l.predicate,
          object: l.object,
          citation: citation(l),
        })),
        citations: c.quotes.map(citation),
        branch: c.branch,
        validFrom: c.validFrom,
        validTo: c.validTo,
        action: 'add',
        target: null,
        reason: 'New supported claim',
      },
    })
}
