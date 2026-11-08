import type {
  BrainClaim,
  BrainCorrection,
  BrainEvidence,
  BrainRevision,
} from '@phosphor/shared/brain'
import { createHash } from 'node:crypto'
import { type Data, identifier } from './data'
import { type Evidence } from './evidence'
import { type Proposals } from './proposals'
import * as validate from './validation'

export class Corrections {
  constructor(
    readonly data: Data,
    readonly evidence: Evidence,
    readonly proposals: Proposals,
  ) {}
  correct(id: string, correction: BrainCorrection, revision: BrainRevision): BrainClaim {
    validate.text(id)
    validate.correction(correction)
    validate.revision(revision)
    const old = this.data.require('claims', id)
    this.data.consent(old.scope)
    validate.check(this.data.revision().policyEpoch === revision.policyEpoch, 'Stale consent')
    const receiptId = identifier(
      'correction',
      id,
      correction,
      revision.graphRevision,
      revision.policyEpoch,
    )
    const receipt = this.data.get('receipts', receiptId)
    if (receipt?.result) return this.data.require('claims', receipt.result)
    this.data.assertRevision(revision)
    validate.check(old.state !== 'superseded', 'Claim already superseded')
    for (const entityId of [
      correction.subjectId,
      ...(correction.objectId ? [correction.objectId] : []),
    ]) {
      validate.check(
        this.data.require('entities', entityId).scope === old.scope,
        'Cross-scope correction',
      )
    }
    for (const citation of old.citations) this.evidence.read(citation.evidenceId, [old.scope])
    const now = this.data.now()
    const text = `Human correction: ${correction.summary}\nReason: ${correction.reason}\nFields: ${JSON.stringify(correction)}`
    const source: BrainEvidence = {
      id: identifier('human', receiptId),
      hash: createHash('sha256').update(text).digest('hex'),
      scope: old.scope,
      sessionId: 'human-review',
      entryId: receiptId,
      parentId: null,
      rootIds: [identifier('human-root', receiptId)],
      branch: null,
      role: 'user',
      label: 'Human correction',
      observedAt: now,
      text,
    }
    validate.check(!this.data.tombstoned(source.id), 'Human evidence forgotten')
    const { reason: _reason, ...correctedFields } = correction
    const claim: BrainClaim = {
      ...old,
      ...correctedFields,
      id: identifier('corrected', receiptId),
      kind: 'reported',
      state: 'active',
      citations: [{ evidenceId: source.id, quote: correction.summary }],
      conflictIds: [],
      recordedAt: now,
      retractedAt: null,
      revision: 1,
    }
    return this.data.transaction(() => {
      this.evidence.write(source)
      this.provenance(old, claim, source)
      this.proposals.supersede(old)
      this.proposals.conflicts(claim)
      this.data.saveClaim(claim)
      this.data.put('receipts', receiptId, old.scope, {
        id: receiptId,
        value: receiptId,
        result: claim.id,
      })
      this.data.bump()
      return claim
    })
  }
  private provenance(old: BrainClaim, claim: BrainClaim, source: BrainEvidence): void {
    const provenance = this.data.db
      .prepare('SELECT evidence_id FROM claim_sources WHERE claim_id=?')
      .all(old.id)
    for (const evidenceId of new Set([
      ...provenance.map((row) => String(row.evidence_id)),
      ...old.citations.map((citation) => citation.evidenceId),
    ])) {
      this.data.db
        .prepare('INSERT OR IGNORE INTO evidence_sources VALUES (?,?)')
        .run(evidenceId, source.id)
      this.data.db
        .prepare('INSERT OR IGNORE INTO claim_sources VALUES (?,?)')
        .run(claim.id, evidenceId)
    }
    this.data.db
      .prepare('INSERT OR IGNORE INTO claim_sources VALUES (?,?)')
      .run(claim.id, source.id)
  }
}
