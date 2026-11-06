// Builds the synthetic retrieval-evaluation corpus (retrieval-eval.json) into a
// real memory store through its public port: capture, processor job, proposal,
// human approval. Nothing here ranks or scores; see retrieval-eval-score.ts.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  BrainEntityKind,
  BrainEpistemicKind,
  BrainEvidence,
  BrainPredicate,
  BrainProposalInput,
} from '@phosphor/shared/brain'
import type { MemoryStorePort } from '../ports'
import { openMemoryStore } from '../service'

export type EvalCategory =
  | 'paraphrase'
  | 'lexical'
  | 'alias'
  | 'relationship'
  | 'branch'
  | 'temporal'
  | 'conflict'
  | 'unanswerable'
  | 'scope'
export type EvalViolation = 'branch' | 'temporal' | 'scope'
export interface EvalEvidence {
  key: string
  scope: string
  branch: string | null
  phase: 1 | 2
  role: BrainEvidence['role']
  session: string
  text: string
}
export interface EvalClaim {
  key: string
  subject: string
  predicate: BrainPredicate
  object?: string
  literal?: string
  summary: string
  kind: BrainEpistemicKind
  citations: { evidence: string; quote: string }[]
  validFrom: number | null
  validTo: number | null
  supersedes?: string
}
export interface EvalJob {
  scope: string
  phase: 1 | 2
  entities: {
    key: string
    label: string
    kind: BrainEntityKind
    aliases: string[]
    evidence: string[]
  }[]
  claims: EvalClaim[]
}
export interface EvalQuery {
  id: string
  category: EvalCategory
  text: string
  branch?: string
  validAt?: number
  knownAt?: number
  gold: string[]
  forbid: { claim: string; why: EvalViolation }[]
}
export interface EvalFixture {
  version: 1
  notes: string
  clock: { phase1: number; phase2: number; query: number }
  scopes: string[]
  allowedScopes: string[]
  evidence: EvalEvidence[]
  jobs: EvalJob[]
  queries: EvalQuery[]
}
export interface EvalStore {
  store: MemoryStorePort
  clock: { now: number }
  /** Fixture key -> store id, and back. */
  evidenceIds: Map<string, string>
  claimIds: Map<string, string>
  evidenceKey: Map<string, string>
  claimKey: Map<string, string>
}

export const EVAL_FIXTURE_PATH = join(import.meta.dirname, 'retrieval-eval.json')
export const EVAL_PROCESSOR = { provider: 'synthetic', id: 'fixture-proposals' }

export function loadEvalFixture(): { fixture: EvalFixture; sha256: string } {
  const bytes = readFileSync(EVAL_FIXTURE_PATH)
  return {
    fixture: JSON.parse(bytes.toString('utf8')) as EvalFixture,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export function allClaims(fixture: EvalFixture): EvalClaim[] {
  return fixture.jobs.flatMap((job) => job.claims)
}

function proposalInput(job: EvalJob, built: EvalStore): BrainProposalInput {
  const evidence = (key: string) => built.evidenceIds.get(key)!
  return {
    entities: job.entities.map((entity) => ({
      key: entity.key,
      label: entity.label,
      kind: entity.kind,
      aliases: entity.aliases,
      evidenceIds: entity.evidence.map(evidence),
    })),
    claims: job.claims.map(({ key: _key, citations, supersedes, ...claim }) => ({
      ...claim,
      citations: citations.map((c) => ({ evidenceId: evidence(c.evidence), quote: c.quote })),
      ...(supersedes ? { supersedes: built.claimIds.get(supersedes)! } : {}),
    })),
    rationale: 'Synthetic retrieval evaluation fixture',
  }
}

function applyJob(job: EvalJob, built: EvalStore): void {
  const { store } = built
  const created = store.createJob(job.scope, EVAL_PROCESSOR, store.snapshot().policyEpoch)
  const running = store.claimJob(created.id)
  const pending = store.submit(running.id, running.fence, proposalInput(job, built))
  store.review(pending.id, true, store.snapshot())
  const bySummary = new Map(
    store.snapshot().claims.map((claim) => [`${claim.scope}\n${claim.summary}`, claim.id]),
  )
  for (const claim of job.claims) {
    const id = bySummary.get(`${job.scope}\n${claim.summary}`)
    if (!id) throw new Error(`Fixture claim ${claim.key} was not applied`)
    built.claimIds.set(claim.key, id)
    built.claimKey.set(id, claim.key)
  }
}

/** Phase 1 evidence and jobs, then phase 2, then the clock moves to query time. */
export function buildEvalStore(
  fixture: EvalFixture,
  directory: string,
  Database: typeof DatabaseSync,
): EvalStore {
  const clock = { now: fixture.clock.phase1 }
  const store = openMemoryStore({ directory, Database, now: () => clock.now })
  const built: EvalStore = {
    store,
    clock,
    evidenceIds: new Map(),
    claimIds: new Map(),
    evidenceKey: new Map(),
    claimKey: new Map(),
  }
  store.setPrefs({
    enabled: true,
    recall: true,
    workspaces: fixture.scopes,
    processor: EVAL_PROCESSOR,
    retentionDays: 3650,
  })
  for (const phase of [1, 2] as const) {
    clock.now = phase === 1 ? fixture.clock.phase1 : fixture.clock.phase2
    for (const item of fixture.evidence.filter((evidence) => evidence.phase === phase)) {
      const captured = store.capture({
        scope: item.scope,
        sessionId: item.session,
        entryId: item.key,
        parentId: null,
        rootIds: [item.key],
        branch: item.branch,
        role: item.role,
        label: 'Synthetic transcript',
        observedAt: clock.now,
        text: item.text,
      })
      if (!captured) throw new Error(`Fixture evidence ${item.key} was not captured`)
      built.evidenceIds.set(item.key, captured.id)
      built.evidenceKey.set(captured.id, item.key)
    }
    for (const job of fixture.jobs.filter((entry) => entry.phase === phase)) applyJob(job, built)
  }
  clock.now = fixture.clock.query
  return built
}
