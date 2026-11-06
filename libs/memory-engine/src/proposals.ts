import type {
  BrainClaim,
  BrainEntity,
  BrainJob,
  BrainProposal,
  BrainProposalInput,
  BrainRevision,
} from '@phosphor/shared/brain'
import { type Data, identifier } from './data'
import { type Evidence } from './evidence'
import { type Jobs } from './jobs'
import { saveEntity } from './entities'
import * as validate from './validation'

export class Proposals {
  constructor(
    readonly data: Data,
    readonly evidence: Evidence,
    readonly jobs: Jobs,
  ) {}
  validateReferences(input: BrainProposalInput, job: BrainJob, replay = false): void {
    const allowed = new Set(job.evidenceIds)
    const source = (id: string) => {
      validate.check(allowed.has(id), 'Evidence not in processor job')
      const item = this.evidence.read(id, [job.scope])
      validate.check(item.scope === job.scope, 'Cross-scope evidence')
      return item
    }
    const keys = new Set(input.entities.map((entity) => entity.key))
    for (const entity of input.entities) {
      for (const id of entity.evidenceIds) source(id)
      if (entity.existingId)
        validate.check(
          this.data.require('entities', entity.existingId).scope === job.scope,
          'Cross-scope entity',
        )
    }
    for (const claim of input.claims) {
      validate.check(
        keys.has(claim.subject) && (claim.object === undefined || keys.has(claim.object)),
        'Unknown entity key',
      )
      for (const citation of claim.citations) {
        validate.check(
          source(citation.evidenceId).text.includes(citation.quote),
          'Quote absent from original evidence',
        )
      }
      if (claim.supersedes) {
        const old = this.data.require('claims', claim.supersedes)
        validate.check(
          old.scope === job.scope && (replay || old.state !== 'superseded'),
          'Invalid supersession reference',
        )
      }
    }
  }
  submit(jobId: string, fence: number, input: BrainProposalInput): BrainProposal {
    validate.proposal(input)
    const id = identifier('proposal', jobId, input)
    const existing = this.data.get('proposals', id)
    const job = this.jobs.get(jobId)
    if (existing && job.state === 'proposed') {
      this.data.consent(job.scope)
      validate.check(
        job.policyEpoch === this.data.revision().policyEpoch && job.fence === fence,
        'Stale consent or fence',
      )
      this.validateReferences(input, job, true)
      return existing
    }
    this.jobs.fenced(jobId, fence)
    validate.check(job.state === 'running', 'Processor is not running')
    this.validateReferences(input, job)
    const proposal: BrainProposal = {
      id,
      jobId,
      scope: job.scope,
      createdAt: this.data.now(),
      state: 'pending',
      input,
      graphRevision: job.graphRevision,
      policyEpoch: job.policyEpoch,
    }
    this.data.transaction(() => {
      this.data.put('proposals', id, job.scope, proposal)
      this.data.put('jobs', jobId, job.scope, {
        ...job,
        state: 'proposed',
        updatedAt: this.data.now(),
      })
    })
    return proposal
  }
  review(id: string, approve: boolean, revision: BrainRevision): void {
    validate.text(id)
    validate.revision(revision)
    validate.check(typeof approve === 'boolean', 'Invalid review choice')
    const proposal = this.data.require('proposals', id)
    this.data.consent(proposal.scope)
    validate.check(revision.policyEpoch === this.data.revision().policyEpoch, 'Stale consent')
    const receiptId = identifier('review', id)
    const value = identifier(approve, revision.graphRevision, revision.policyEpoch)
    const receipt = this.data.get('receipts', receiptId)
    if (receipt) {
      validate.check(receipt.value === value, 'Conflicting review retry')
      return
    }
    this.data.assertRevision(revision)
    this.data.assertRevision(proposal)
    validate.check(proposal.state === 'pending', 'Proposal already reviewed')
    if (approve) this.validateReferences(proposal.input, this.jobs.get(proposal.jobId))
    this.data.transaction(() => {
      if (approve) this.apply(proposal)
      this.data.put('proposals', id, proposal.scope, {
        ...proposal,
        state: approve ? 'applied' : 'rejected',
      })
      this.data.put('receipts', receiptId, proposal.scope, { id: receiptId, value, result: null })
      if (approve) this.data.bump()
    })
  }
  private entities(proposal: BrainProposal): Map<string, string> {
    const ids = new Map<string, string>()
    for (const entity of proposal.input.entities) {
      const id =
        entity.existingId ??
        identifier(
          'entity',
          proposal.scope,
          entity.kind,
          entity.label.normalize('NFKC').toLowerCase(),
        )
      const next: BrainEntity = {
        id,
        scope: proposal.scope,
        label: entity.label,
        kind: entity.kind,
        aliases: [...new Set(entity.aliases)],
      }
      saveEntity(this.data, identifier(proposal.id, entity.key), next, entity.evidenceIds)
      ids.set(entity.key, id)
    }
    return ids
  }
  private apply(proposal: BrainProposal): void {
    const ids = this.entities(proposal)
    for (const proposed of proposal.input.claims) {
      const sources = proposed.citations
        .map((citation) => ({
          quote: citation.quote,
          roots: this.data.require('evidence', citation.evidenceId).rootIds,
        }))
        .sort((a, b) => identifier(a).localeCompare(identifier(b)))
      const fingerprint = {
        subject: ids.get(proposed.subject),
        predicate: proposed.predicate,
        object: proposed.object ? ids.get(proposed.object) : null,
        literal: proposed.literal ?? null,
        summary: proposed.summary,
        kind: proposed.kind,
        validFrom: proposed.validFrom,
        validTo: proposed.validTo,
        sources,
      }
      const claim: BrainClaim = {
        id: identifier('claim', proposal.scope, fingerprint),
        scope: proposal.scope,
        subjectId: ids.get(proposed.subject)!,
        predicate: proposed.predicate,
        objectId: proposed.object ? ids.get(proposed.object)! : null,
        literal: proposed.literal ?? null,
        summary: proposed.summary,
        kind: proposed.kind,
        state: 'active',
        citations: proposed.citations,
        conflictIds: [],
        validFrom: proposed.validFrom,
        validTo: proposed.validTo,
        recordedAt: this.data.now(),
        retractedAt: null,
        revision: 1,
      }
      if (this.data.get('claims', claim.id)) continue
      if (proposed.supersedes) {
        const old = this.data.require('claims', proposed.supersedes)
        validate.check(
          old.subjectId === claim.subjectId && old.predicate === claim.predicate,
          'Supersession changes relationship',
        )
        this.supersede(old)
      }
      this.conflicts(claim)
      this.data.saveClaim(claim)
      const entityKeys = new Set([proposed.subject, proposed.object])
      const provenance = [
        ...proposed.citations.map((citation) => citation.evidenceId),
        ...proposal.input.entities
          .filter((entity) => entityKeys.has(entity.key))
          .flatMap((entity) => entity.evidenceIds),
      ]
      for (const evidenceId of new Set(provenance))
        this.data.db
          .prepare('INSERT OR IGNORE INTO claim_sources VALUES (?,?)')
          .run(claim.id, evidenceId)
    }
  }
  supersede(claim: BrainClaim): void {
    this.data.saveClaim({
      ...claim,
      state: 'superseded',
      retractedAt: this.data.now(),
      revision: claim.revision + 1,
    })
  }
  conflicts(claim: BrainClaim): void {
    for (const other of this.data.all('claims', [claim.scope])) {
      const overlaps =
        (other.validTo ?? Infinity) > (claim.validFrom ?? -Infinity) &&
        (claim.validTo ?? Infinity) > (other.validFrom ?? -Infinity)
      if (
        other.state === 'superseded' ||
        other.subjectId !== claim.subjectId ||
        other.predicate !== claim.predicate ||
        !overlaps
      )
        continue
      if (other.objectId === claim.objectId && other.literal === claim.literal) continue
      claim.state = 'contested'
      claim.conflictIds.push(other.id)
      this.data.saveClaim({
        ...other,
        state: 'contested',
        conflictIds: [...new Set([...other.conflictIds, claim.id])],
        revision: other.revision + 1,
      })
    }
  }
}
