import type { BrainStatus } from '@shared/brain'
import { DEFAULT_BRAIN_PREFS } from '@shared/brain'

export function brainFixture(): BrainStatus {
  return {
    supported: true,
    notice: 'Synthetic test evidence only.',
    embedding: { phase: 'missing', receivedBytes: 0, totalBytes: 100, modelId: 'local-test', dimensions: 384 },
    snapshot: {
      graphRevision: 3, policyEpoch: 2,
      prefs: { ...DEFAULT_BRAIN_PREFS, workspaces: ['/synthetic'] },
      entities: [{ id: 'entity', scope: '/synthetic', label: 'Synthetic project', kind: 'project', aliases: [] }],
      claims: [{ id: 'claim', scope: '/synthetic', subjectId: 'entity', predicate: 'about', objectId: null, literal: 'test', summary: 'Synthetic claim', kind: 'inferred', state: 'contested', citations: [{ evidenceId: 'evidence', quote: 'Original synthetic quote' }], conflictIds: ['other'], validFrom: null, validTo: null, recordedAt: 1, retractedAt: null, revision: 1 }],
      proposals: [{ id: 'proposal', jobId: 'job', scope: '/synthetic', createdAt: 1, state: 'pending', graphRevision: 3, policyEpoch: 2, input: { entities: [], claims: [{ subject: 'entity', predicate: 'about', literal: 'test', summary: 'Proposed synthetic fact', kind: 'reported', citations: [{ evidenceId: 'evidence', quote: 'Original synthetic quote' }], validFrom: null, validTo: null }], rationale: 'Test proposal' } }],
      jobs: [], evidence: [{ id: 'evidence', scope: '/synthetic', label: 'Synthetic note', role: 'user', observedAt: 1 }],
      counts: { evidence: 1, claims: 1, entities: 1, vectors: 0 }, truncated: false,
    },
  }
}
