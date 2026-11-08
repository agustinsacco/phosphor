import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrainCapture, BrainProposalInput } from '@phosphor/shared/brain'
import { openMemoryStore } from './service'

const directories: string[] = []
const stores: ReturnType<typeof openMemoryStore>[] = []
const model = { provider: 'test', id: 'reasoner' }
const prefs = {
  enabled: true,
  recall: true,
  workspaces: ['/a'],
  processor: model,
  retentionDays: 30,
}
const capture: BrainCapture = {
  scope: '/a',
  sessionId: 'lane',
  entryId: 'entry',
  parentId: null,
  rootIds: ['root'],
  branch: null,
  role: 'user',
  label: 'Source',
  observedAt: 100,
  text: 'Alice owns Project. Bob blocks Project.',
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'brain-engine-'))
  directories.push(directory)
  const open = () => {
    const store = openMemoryStore({ directory, Database: DatabaseSync, now: () => 1000 })
    stores.push(store)
    return store
  }
  const store = open()
  store.setPrefs(prefs)
  return { store, open, directory }
}
function proposal(evidenceId: string): BrainProposalInput {
  return {
    entities: [
      { key: 'alice', label: 'Alice', kind: 'person', aliases: ['Al'], evidenceIds: [evidenceId] },
      { key: 'project', label: 'Project', kind: 'project', aliases: [], evidenceIds: [evidenceId] },
    ],
    claims: [
      {
        subject: 'alice',
        predicate: 'owns',
        object: 'project',
        summary: 'Alice owns Project',
        kind: 'reported',
        citations: [{ evidenceId, quote: 'Alice owns Project' }],
        validFrom: 0,
        validTo: null,
      },
    ],
    rationale: 'Explicit source',
  }
}
function propose(store: ReturnType<typeof openMemoryStore>) {
  const evidence = store.capture(capture)!
  const job = store.createJob('/a', model)
  const claimed = store.claimJob(job.id)
  const pending = store.submit(job.id, claimed.fence, proposal(evidence.id))
  return { evidence, job: claimed, pending }
}
function approve(store: ReturnType<typeof openMemoryStore>) {
  const result = propose(store)
  store.review(result.pending.id, true, store.snapshot())
  return { ...result, claim: store.snapshot().claims[0]! }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
describe('memory engine consent, provenance and recovery', () => {
  it('defaults off and captures only enrolled scopes with stable duplicate identities', () => {
    const { store, directory } = setup()
    store.setPrefs({ ...prefs, enabled: false })
    expect(store.capture(capture)).toBeNull()
    store.setPrefs(prefs)
    expect(store.capture({ ...capture, scope: '/private' })).toBeNull()
    const first = store.capture(capture)!
    expect(store.capture(capture)).toEqual(first)
    expect(() => store.capture({ ...capture, text: 'different' })).toThrow()
    expect(store.snapshot().counts.evidence).toBe(1)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(() => store.read(first.id, ['/private'])).toThrow()
  })
  it('persists evidence and interrupts running jobs on restart with new fences', () => {
    const { store, open } = setup()
    const evidence = store.capture(capture)!
    const running = store.claimJob(store.createJob('/a', model).id)
    store.close()
    const reopened = open()
    expect(reopened.read(evidence.id, ['/a'])).toEqual(evidence)
    expect(reopened.job(running.id).state).toBe('interrupted')
    const retry = reopened.claimJob(running.id)
    expect(retry.fence).toBeGreaterThan(running.fence)
    expect(() => reopened.submit(retry.id, running.fence, proposal(evidence.id))).toThrow()
  })
  it('requires explicit processor consent and rejects stale epochs and graph revisions', () => {
    const { store } = setup()
    expect(() => store.createJob('/a', { provider: 'other', id: 'model' })).toThrow()
    const { pending } = propose(store)
    store.setPrefs({ ...prefs, recall: false })
    expect(() => store.review(pending.id, true, pending)).toThrow()
    expect(store.snapshot().claims).toHaveLength(0)
  })
  it('atomically rejects stale processing consent even when the model is unchanged', () => {
    const { store } = setup()
    store.capture(capture)
    const consentEpoch = store.snapshot().policyEpoch
    store.setPrefs({ ...prefs, recall: false })
    expect(() => store.createJob('/a', model, consentEpoch)).toThrow('Stale processing consent')
    expect(store.snapshot().jobs).toHaveLength(0)
    expect(store.createJob('/a', model, store.snapshot().policyEpoch).state).toBe('queued')
  })
  it('validates references, quotes, typed predicates and same-scope existing entities', () => {
    const { store } = setup()
    const evidence = store.capture(capture)!
    const job = store.claimJob(store.createJob('/a', model).id)
    const bad = proposal(evidence.id)
    bad.claims[0]!.citations[0]!.quote = 'invented'
    expect(() => store.submit(job.id, job.fence, bad)).toThrow()
    const unknown = proposal(evidence.id)
    unknown.claims[0]!.object = 'unknown'
    expect(() => store.submit(job.id, job.fence, unknown)).toThrow()
    expect(store.snapshot().proposals).toHaveLength(0)
  })
  it('applies human reviews once and keeps exact retries idempotent', () => {
    const { store } = setup()
    const { pending, job, evidence } = propose(store)
    expect(store.submit(job.id, job.fence, proposal(evidence.id)).id).toBe(pending.id)
    const revision = store.snapshot()
    store.review(pending.id, true, revision)
    store.review(pending.id, true, revision)
    expect(store.snapshot().counts.claims).toBe(1)
    expect(() => store.review(pending.id, false, revision)).toThrow()
    expect(store.embeddingItems('local', 10)).toHaveLength(1)
  })
  it('corrects with human evidence, supersedes rather than overwrites, and invalidates vectors', () => {
    const { store } = setup()
    const { claim } = approve(store)
    store.putVectors([{ claimId: claim.id, modelId: 'local', values: [1, 0] }])
    const revision = store.snapshot()
    const correction = {
      subjectId: claim.subjectId,
      predicate: claim.predicate,
      objectId: claim.objectId,
      literal: claim.literal,
      summary: 'Alice no longer owns Project',
      validFrom: 500,
      validTo: null,
      reason: 'Human correction',
    }
    const corrected = store.correct(claim.id, correction, revision)
    expect(store.correct(claim.id, correction, revision)).toEqual(corrected)
    expect(store.snapshot().claims.find((item) => item.id === claim.id)?.state).toBe('superseded')
    expect(store.read(corrected.citations[0]!.evidenceId, ['/a']).role).toBe('user')
    expect(store.snapshot().counts.vectors).toBe(0)
    expect(() => store.correct(corrected.id, correction, revision)).toThrow()
  })
  it('forgets permanently across retries, restart, and repeated fork roots', () => {
    const { store, open } = setup()
    const { evidence, claim } = approve(store)
    const fork = store.capture({
      ...capture,
      sessionId: 'fork',
      entryId: 'fork-entry',
      rootIds: ['root', 'root'],
    })!
    expect(fork.rootIds).toEqual(['root'])
    store.recordDelivery({
      sessionId: 'recipient',
      evidenceIds: [evidence.id],
      claimIds: [claim.id],
    })
    const result = store.forget([evidence.id])
    expect(result.evidence).toBe(2)
    expect(result.affectedSessions).toContain('recipient')
    expect(store.snapshot().counts.claims).toBe(0)
    expect(store.capture(capture)).toBeNull()
    expect(store.forget([evidence.id]).evidence).toBe(0)
    store.close()
    const reopened = open()
    expect(reopened.capture({ ...capture, sessionId: 'another-fork' })).toBeNull()
  })
  it('never ingests evidence from known processor sessions or delivery echoes', () => {
    const { store } = setup()
    const { job, evidence, claim } = approve(store)
    expect(store.capture({ ...capture, sessionId: job.id, entryId: 'processor' })).toBeNull()
    store.recordDelivery({
      sessionId: 'recipient',
      evidenceIds: [evidence.id],
      claimIds: [claim.id],
    })
    expect(store.capture({ ...capture, sessionId: 'recipient', entryId: 'echo' })).toBeNull()
  })
})
describe('memory engine retrieval', () => {
  it('narrows enrollment before lexical, exact aliases, temporal and vector ranking', () => {
    const { store } = setup()
    const { claim } = approve(store)
    expect(store.search({ query: 'Al', mode: 'lexical' }, ['/a']).results[0]?.claim.id).toBe(
      claim.id,
    )
    expect(store.search({ query: 'Alice', validAt: -1 }, ['/a']).results).toHaveLength(0)
    expect(store.search({ query: 'Alice', knownAt: 999 }, ['/a']).results).toHaveLength(0)
    expect(store.search({ query: 'Alice', scopes: ['/a'] }, ['/private']).results).toHaveLength(0)
    expect(() => store.search({ query: '" OR * NOT NEAR(' }, ['/a'])).not.toThrow()
    const unavailable = store.search({ query: 'Alice', mode: 'hybrid' }, ['/a'])
    expect(unavailable.degradation.length).toBeGreaterThan(0)
    expect(unavailable.status).toBe('partial')
    store.putVectors([{ claimId: claim.id, modelId: 'local', values: [1, 0] }])
    expect(
      store.search({ query: 'unrelated', mode: 'hybrid' }, ['/a'], {
        modelId: 'local',
        values: [1, 0],
      }).results[0]?.reasons,
    ).toContain('semantic')
  })
  it('bounds evidence packing, snapshots and graph queries', () => {
    const { store } = setup()
    const { claim } = approve(store)
    const graph = store.graph(claim.subjectId)
    expect(graph.edges[0]?.id).toBe(claim.id)
    expect(store.graph('absent').edges).toHaveLength(0)
    const packed = store.search({ query: 'Alice', tokenBudget: 1 }, ['/a'])
    expect(packed.results).toHaveLength(0)
    expect(packed.truncated).toBe(true)
  })
})
