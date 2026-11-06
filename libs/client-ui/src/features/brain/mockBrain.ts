import {
  BRAIN_EMBEDDING_MODEL,
  DEFAULT_BRAIN_PREFS,
  type BrainClaim,
  type BrainCorrection,
  type BrainEvidence,
  type BrainJob,
  type BrainPrefs,
  type BrainProposal,
  type BrainProcessConsent,
  type BrainRevision,
  type BrainStatus,
} from '@shared/brain'

/** Synthetic browser-harness simulation. Never reads files, downloads, or runs models. */
const state: BrainStatus = {
  supported: true,
  notice: 'Browser harness: synthetic evidence only; no model or filesystem access.',
  embedding: {
    phase: 'missing',
    receivedBytes: 0,
    totalBytes: BRAIN_EMBEDDING_MODEL.downloadBytes,
    modelId: BRAIN_EMBEDDING_MODEL.id,
    dimensions: BRAIN_EMBEDDING_MODEL.dimensions,
  },
  snapshot: {
    graphRevision: 0,
    policyEpoch: 0,
    prefs: structuredClone(DEFAULT_BRAIN_PREFS),
    entities: [],
    claims: [],
    proposals: [],
    jobs: [],
    evidence: [],
    counts: { evidence: 0, claims: 0, entities: 0, vectors: 0 },
    truncated: false,
  },
}
let evidence: BrainEvidence[] = []
function checkRevision(revision: BrainRevision): void {
  if (
    revision.graphRevision !== state.snapshot.graphRevision ||
    revision.policyEpoch !== state.snapshot.policyEpoch
  )
    throw new Error('Stale review. Refresh and review original evidence again.')
}
function setPrefs(prefs: BrainPrefs): BrainStatus {
  state.snapshot.prefs = structuredClone(prefs)
  state.snapshot.policyEpoch++
  if (prefs.enabled && prefs.workspaces[0] && !evidence.length) {
    evidence = [
      {
        id: 'synthetic-evidence',
        scope: prefs.workspaces[0],
        sessionId: 'synthetic-session',
        entryId: 'synthetic-entry',
        parentId: null,
        rootIds: ['synthetic-root'],
        branch: null,
        role: 'user',
        label: 'Synthetic example · not a real transcript',
        observedAt: Date.now(),
        text: 'Synthetic example: Project Lantern depends on Component Beacon.',
        hash: 'synthetic',
      },
    ]
    state.snapshot.evidence = evidence.map(({ id, scope, label, role, observedAt }) => ({
      id,
      scope,
      label,
      role,
      observedAt,
    }))
    state.snapshot.counts.evidence = evidence.length
  }
  return state
}
function process(scope: string, consent: BrainProcessConsent): BrainJob {
  const snapshot = state.snapshot
  const prefs = snapshot.prefs
  if (
    !consent ||
    consent.policyEpoch !== snapshot.policyEpoch ||
    consent.model?.provider !== prefs.processor?.provider ||
    consent.model?.id !== prefs.processor?.id
  )
    throw new Error('Processing consent changed. Refresh and consent to the exact model again.')
  if (!prefs.enabled || !prefs.workspaces.includes(scope) || !prefs.processor)
    throw new Error('Enable Brain, enroll workspace and choose an exact processor first.')
  const job: BrainJob = {
    id: crypto.randomUUID(),
    scope,
    evidenceIds: evidence.filter((e) => e.scope === scope).map((e) => e.id),
    model: prefs.processor,
    state: 'proposed',
    fence: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionPath: 'synthetic-only',
    error: null,
    graphRevision: snapshot.graphRevision,
    policyEpoch: snapshot.policyEpoch,
  }
  if (!job.evidenceIds.length) throw new Error('No synthetic evidence in this workspace.')
  snapshot.jobs.unshift(job)
  const proposal: BrainProposal = {
    id: crypto.randomUUID(),
    jobId: job.id,
    scope,
    createdAt: Date.now(),
    state: 'pending',
    graphRevision: snapshot.graphRevision,
    policyEpoch: snapshot.policyEpoch,
    input: {
      rationale: 'Synthetic example for review.',
      entities: [
        {
          key: 'lantern',
          label: 'Project Lantern',
          kind: 'project',
          aliases: [],
          evidenceIds: job.evidenceIds,
        },
        {
          key: 'beacon',
          label: 'Component Beacon',
          kind: 'component',
          aliases: [],
          evidenceIds: job.evidenceIds,
        },
      ],
      claims: [
        {
          subject: 'lantern',
          predicate: 'depends_on',
          object: 'beacon',
          summary: 'Project Lantern depends on Component Beacon',
          kind: 'reported',
          citations: [{ evidenceId: job.evidenceIds[0]!, quote: evidence[0]!.text }],
          validFrom: null,
          validTo: null,
        },
      ],
    },
  }
  snapshot.proposals.unshift(proposal)
  return job
}
function review(id: string, approve: boolean, revision: BrainRevision): void {
  if (approve) checkRevision(revision)
  const snapshot = state.snapshot
  const proposal = snapshot.proposals.find((p) => p.id === id && p.state === 'pending')
  if (!proposal) throw new Error('Pending proposal not found.')
  if (
    revision.policyEpoch !== snapshot.policyEpoch ||
    proposal.policyEpoch !== snapshot.policyEpoch
  )
    throw new Error('Stale consent.')
  proposal.state = approve ? 'applied' : 'rejected'
  if (!approve) return
  snapshot.entities = proposal.input.entities.map((e) => ({
    id: e.key,
    scope: proposal.scope,
    label: e.label,
    kind: e.kind,
    aliases: e.aliases,
  }))
  snapshot.claims.push(
    ...proposal.input.claims.map((c): BrainClaim => ({
      id: crypto.randomUUID(),
      scope: proposal.scope,
      subjectId: c.subject,
      predicate: c.predicate,
      objectId: c.object ?? null,
      literal: c.literal ?? null,
      summary: c.summary,
      kind: c.kind,
      state: 'active',
      citations: c.citations,
      conflictIds: [],
      validFrom: c.validFrom,
      validTo: c.validTo,
      recordedAt: Date.now(),
      retractedAt: null,
      revision: 1,
    })),
  )
  snapshot.graphRevision++
  snapshot.counts.entities = snapshot.entities.length
  snapshot.counts.claims = snapshot.claims.length
}
function correct(id: string, correction: BrainCorrection, revision: BrainRevision): void {
  checkRevision(revision)
  const claim = state.snapshot.claims.find((c) => c.id === id)
  if (!claim) throw new Error('Claim not found.')
  Object.assign(claim, correction, { revision: claim.revision + 1 })
  state.snapshot.graphRevision++
}
function forget(ids: string[]): { evidence: number; claims: number; affectedSessions: string[] } {
  const removed = evidence.filter((e) => ids.includes(e.id))
  const claims = state.snapshot.claims.filter((c) =>
    c.citations.some((cite) => ids.includes(cite.evidenceId)),
  )
  evidence = evidence.filter((e) => !ids.includes(e.id))
  state.snapshot.evidence = state.snapshot.evidence.filter((e) => !ids.includes(e.id))
  state.snapshot.claims = state.snapshot.claims.filter((c) => !claims.includes(c))
  state.snapshot.graphRevision++
  state.snapshot.policyEpoch++
  state.snapshot.counts.evidence = evidence.length
  state.snapshot.counts.claims = state.snapshot.claims.length
  return { evidence: removed.length, claims: claims.length, affectedSessions: [] }
}
function cancel(id: string): void {
  const job = state.snapshot.jobs.find((j) => j.id === id)
  if (!job) throw new Error('Job not found.')
  job.state = 'cancelled'
}

export async function mockBrainCall(channel: string, args: unknown[]): Promise<unknown> {
  switch (channel) {
    case 'brain:status':
      return structuredClone(state)
    case 'brain:setPrefs':
      return structuredClone(setPrefs(args[0] as BrainPrefs))
    case 'brain:download': {
      if (args[0] !== true) throw new Error('Explicit model terms consent required.')
      state.embedding.phase = 'ready'
      state.embedding.receivedBytes = state.embedding.totalBytes
      return structuredClone(state)
    }
    case 'brain:removeModel':
      state.embedding.phase = 'missing'
      state.embedding.receivedBytes = 0
      return structuredClone(state)
    case 'brain:process':
      return structuredClone(process(String(args[0]), args[1] as BrainProcessConsent))
    case 'brain:review':
      review(String(args[0]), args[1] === true, args[2] as BrainRevision)
      return
    case 'brain:correct':
      correct(String(args[0]), args[1] as BrainCorrection, args[2] as BrainRevision)
      return
    case 'brain:forget':
      return forget(args[0] as string[])
    case 'brain:cancel':
      cancel(String(args[0]))
      return
    case 'brain:transcript':
      return 'Synthetic processing transcript. No provider contacted; no process launched.'
    default:
      return readMockBrain(channel, args)
  }
}

function readMockBrain(channel: string, args: unknown[]): unknown {
  switch (channel) {
    case 'brain:evidence': {
      const items =
        state.snapshot.prefs.enabled && state.snapshot.prefs.workspaces.includes(String(args[0]))
          ? state.snapshot.evidence
              .filter((item) => item.scope === args[0] && (!args[1] || item.id > String(args[1])))
              .sort((a, b) => a.id.localeCompare(b.id))
          : []
      return structuredClone({
        items: items.slice(0, 50),
        nextCursor: items.length > 50 ? items[49]!.id : null,
      })
    }
    case 'brain:graph':
      return structuredClone({
        nodes: state.snapshot.entities,
        edges: state.snapshot.claims,
        truncated: false,
      })
    case 'brain:search':
      return structuredClone({
        graphRevision: state.snapshot.graphRevision,
        policyEpoch: state.snapshot.policyEpoch,
        status: state.snapshot.claims.length ? 'ok' : 'no_match',
        results: state.snapshot.claims.map((claim) => ({
          claim,
          evidence,
          reasons: ['lexical'],
          score: 1,
        })),
        entities: state.snapshot.entities,
        degradation: ['Synthetic harness search only'],
        truncated: false,
      })
    case 'brain:read': {
      const found = evidence.find((e) => e.id === args[0])
      if (!found) throw new Error('Evidence not found.')
      return structuredClone(found)
    }
    default:
      throw new Error('This synthetic Brain operation is unavailable.')
  }
}
