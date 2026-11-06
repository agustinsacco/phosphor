import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { BrainJob, BrainProposal, BrainProposalInput } from '@phosphor/shared/brain'
import { Data } from './data'
import { openMemoryStore } from './service'
import { proposal as validateProposal } from './validation'

const model = { provider: 'synthetic', id: 'workflow-repair' }
const prefs = {
  enabled: true,
  recall: false,
  workspaces: ['/a', '/b'],
  processor: model,
  retentionDays: 30,
}
const cleanups: (() => void)[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'brain-workflow-repair-'))
  let now = 1000
  const store = openMemoryStore({ directory, Database: DatabaseSync, now: () => now })
  store.setPrefs(prefs)
  const data = new Data({ directory, Database: DatabaseSync, now: () => now })
  cleanups.push(() => {
    data.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const capture = (entry: string, scope = '/a') =>
    store.capture({
      scope,
      sessionId: 'synthetic-lane',
      entryId: entry,
      parentId: null,
      rootIds: [entry],
      branch: null,
      role: 'user',
      label: entry,
      observedAt: now,
      text: 'Source fact.',
    })!
  return {
    store,
    data,
    capture,
    time: (value: number) => {
      now = value
    },
  }
}
function input(id: string): BrainProposalInput {
  return {
    entities: [{ key: 'source', label: 'Source', kind: 'concept', aliases: [], evidenceIds: [id] }],
    claims: [
      {
        subject: 'source',
        predicate: 'about',
        literal: 'fact',
        summary: 'Source fact',
        kind: 'reported',
        citations: [{ evidenceId: id, quote: 'Source fact.' }],
        validFrom: null,
        validTo: null,
      },
    ],
    rationale: 'Synthetic workflow test',
  }
}
function propose(store: ReturnType<typeof openMemoryStore>, scope = '/a') {
  const job = store.claimJob(store.createJob(scope, model).id)
  const pending = store.submit(job.id, job.fence, input(job.evidenceIds[0]!))
  return { job, pending }
}
function archive(data: Data, job: BrainJob, pending: BrainProposal, count: number) {
  data.transaction(() => {
    for (let index = 0; index < count; index++) {
      const id = `000-archive-${index}`
      data.put('jobs', id, job.scope, {
        ...job,
        id,
        state: 'failed',
        createdAt: 1,
        updatedAt: 99999,
      })
      data.put('proposals', id, pending.scope, {
        ...pending,
        id,
        state: 'rejected',
        createdAt: 99999,
      })
    }
  })
}
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

it('regression: pending proposals and live cancellation stay visible above terminal history', () => {
  const { store, data, capture } = fixture()
  capture('source')
  const { job, pending } = propose(store)
  capture('other', '/b')
  const running = store.claimJob(store.createJob('/b', model).id)
  archive(data, job, pending, 205)
  const snapshot = store.snapshot()
  expect(snapshot.proposals[0]!.id).toBe(pending.id)
  expect(snapshot.jobs[0]!.id).toBe(running.id)
  expect(snapshot.jobs.length).toBeLessThanOrEqual(200)
  expect(snapshot.proposals.length).toBeLessThanOrEqual(200)
  expect(snapshot.truncated).toBe(true)
  store.updateJob(running.id, running.fence, { state: 'cancelled' })
  expect(store.job(running.id).state).toBe('cancelled')
})
it('regression: pending pages are newest first and reveal older work as reviews finish', () => {
  const { store, data, capture } = fixture()
  capture('source')
  const { pending } = propose(store)
  data.remove('proposals', pending.id)
  data.transaction(() => {
    for (let index = 0; index < 205; index++) {
      const id = `pending-${String(index).padStart(3, '0')}`
      data.put('proposals', id, pending.scope, { ...pending, id, createdAt: index })
    }
  })
  const first = store.snapshot()
  expect(first.proposals[0]!.id).toBe('pending-204')
  expect(first.proposals.filter((proposal) => proposal.state === 'pending')).toHaveLength(200)
  for (const proposal of first.proposals) store.review(proposal.id, false, first)
  expect(
    store
      .snapshot()
      .proposals.filter((proposal) => proposal.state === 'pending')
      .map((proposal) => proposal.id),
  ).toEqual(['pending-004', 'pending-003', 'pending-002', 'pending-001', 'pending-000'])
})
it('regression: graph-stale pending work may be rejected but never approved', () => {
  const { store, capture } = fixture()
  capture('first')
  const first = propose(store)
  capture('other', '/b')
  const other = propose(store, '/b')
  store.review(other.pending.id, true, store.snapshot())
  expect(() => store.review(first.pending.id, true, store.snapshot())).toThrow('Stale')
  const revision = store.snapshot()
  store.review(first.pending.id, false, revision)
  store.review(first.pending.id, false, revision)
  expect(
    store.snapshot().proposals.find((proposal) => proposal.id === first.pending.id)!.state,
  ).toBe('rejected')
  expect(store.snapshot().graphRevision).toBe(revision.graphRevision)
})
it('regression: rejection cannot bypass the proposal consent epoch with a refreshed caller epoch', () => {
  const { store, capture } = fixture()
  capture('source')
  const { pending } = propose(store)
  store.setPrefs({ ...prefs, recall: true })
  expect(() => store.review(pending.id, false, store.snapshot())).toThrow()
  store.setPrefs({ ...prefs, enabled: false })
  expect(() => store.review(pending.id, false, store.snapshot())).toThrow()
})
it('regression: explicit manual batches progress past 200 without repeating applied or valid pending work', () => {
  const { store, capture } = fixture()
  const ids = new Set(Array.from({ length: 401 }, (_, index) => capture(`entry-${index}`).id))
  const first = propose(store)
  expect(first.job.evidenceIds).toHaveLength(200)
  expect(store.createJob('/a', model).evidenceIds).not.toEqual(first.job.evidenceIds)
  // Discard the queued second batch so this test can approve in sequence at current graph fences.
  const queued = store.createJob('/a', model)
  store.updateJob(queued.id, queued.fence, { state: 'cancelled' })
  store.review(first.pending.id, true, store.snapshot())
  const second = propose(store)
  expect(second.job.evidenceIds).toHaveLength(200)
  expect(second.job.evidenceIds.some((id) => first.job.evidenceIds.includes(id))).toBe(false)
  store.review(second.pending.id, true, store.snapshot())
  const third = propose(store)
  expect(third.job.evidenceIds).toHaveLength(1)
  store.review(third.pending.id, true, store.snapshot())
  expect(
    new Set([...first.job.evidenceIds, ...second.job.evidenceIds, ...third.job.evidenceIds]),
  ).toEqual(ids)
  expect(() => store.createJob('/a', model)).toThrow('No eligible evidence')
})
it('regression: never-attempted evidence is preferred before an explicit failed retry', () => {
  const { store, capture, time } = fixture()
  const old = capture('attempted')
  const failed = store.claimJob(store.createJob('/a', model).id)
  store.updateJob(failed.id, failed.fence, { state: 'failed', error: 'Synthetic failure' })
  time(2000)
  const fresh = Array.from({ length: 200 }, (_, index) => capture(`fresh-${index}`).id)
  const next = store.createJob('/a', model)
  expect(new Set(next.evidenceIds)).toEqual(new Set(fresh))
  expect(next.evidenceIds).not.toContain(old.id)
  expect(next.id).not.toBe(failed.id)
  expect(store.createJob('/a', model).id).toBe(next.id)
})
it('regression: valid pending work is not repeated merely because fresh evidence arrives', () => {
  const { store, capture } = fixture()
  const old = capture('old')
  propose(store)
  const fresh = capture('new')
  const next = store.createJob('/a', model)
  expect(next.evidenceIds).toEqual([fresh.id])
  expect(next.evidenceIds).not.toContain(old.id)
})
it('regression: count-bounded snapshots stay below the worker response ceiling', () => {
  const { store, data, capture } = fixture()
  capture('source')
  const { pending } = propose(store)
  const large = {
    ...pending.input,
    claims: Array.from({ length: 100 }, () => ({
      ...pending.input.claims[0]!,
      summary: 's'.repeat(7900),
    })),
  }
  validateProposal(large)
  data.transaction(() => {
    for (let index = 0; index < 12; index++) {
      const id = `large-${index}`
      data.put('proposals', id, pending.scope, { ...pending, id, input: large })
    }
  })
  const bytes = Buffer.byteLength(JSON.stringify(store.snapshot()))
  console.info(`Synthetic snapshot bytes: ${bytes}`)
  expect(bytes).toBeLessThanOrEqual(8_600_000)
  expect(store.snapshot().truncated).toBe(true)
})
