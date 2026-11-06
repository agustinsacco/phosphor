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
}, 30_000)
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

function textCapture(store: ReturnType<typeof openMemoryStore>, entryId: string, text: string) {
  return store.capture({
    scope: '/a',
    sessionId: 'synthetic-budget',
    entryId,
    rootIds: [entryId],
    parentId: null,
    branch: null,
    role: 'user',
    label: entryId,
    observedAt: 1000,
    text,
  })!
}
it('regression: manual source-byte batches progress through long messages without clipping', () => {
  const { store } = fixture()
  const ids = [0, 1, 2].map(
    (index) => textCapture(store, `long-${index}`, `Source fact.${'x'.repeat(29988)}`).id,
  )
  const first = propose(store)
  expect(first.job.evidenceIds).toHaveLength(2)
  const bytes = first.job.evidenceIds.reduce(
    (sum, id) => sum + Buffer.byteLength(store.read(id, ['/a']).text),
    0,
  )
  expect(bytes).toBe(60000)
  store.review(first.pending.id, true, store.snapshot())
  const next = store.createJob('/a', model)
  expect(next.evidenceIds).toHaveLength(1)
  expect(new Set([...first.job.evidenceIds, ...next.evidenceIds])).toEqual(new Set(ids))
})
it('regression: source-byte budgeting counts UTF-8 bytes, not JavaScript character length', () => {
  const { store } = fixture()
  for (let index = 0; index < 2; index++)
    textCapture(store, `unicode-${index}`, `Source fact.${'界'.repeat(12000)}`)
  const job = store.createJob('/a', model)
  expect(job.evidenceIds).toHaveLength(1)
  expect(Buffer.byteLength(store.read(job.evidenceIds[0]!, ['/a']).text)).toBe(36012)
})
it('regression: one individually oversized source yields an identifiable budget error', () => {
  const { store } = fixture()
  const source = textCapture(store, 'oversized', 'x'.repeat(60001))
  expect(() => store.createJob('/a', model)).toThrow(source.id)
  expect(() => store.createJob('/a', model)).toThrow('60000')
  expect(store.snapshot().jobs).toHaveLength(0)
})
it.each(['failed', 'cancelled', 'rejected', 'graph-stale', 'policy-stale', 'interrupted'])(
  'explicit retry creates a new fenced job for %s work',
  (state) => {
    const { store, data, capture } = fixture()
    const source = capture('retry-source')
    const initial = store.claimJob(store.createJob('/a', model).id)
    if (state === 'failed' || state === 'cancelled')
      store.updateJob(initial.id, initial.fence, { state })
    if (state === 'interrupted')
      data.put('jobs', initial.id, initial.scope, { ...initial, state: 'interrupted' })
    if (state === 'policy-stale') store.setPrefs({ ...prefs, recall: true })
    if (state === 'rejected' || state === 'graph-stale') {
      const pending = store.submit(initial.id, initial.fence, input(source.id))
      if (state === 'rejected') store.review(pending.id, false, store.snapshot())
      else {
        capture('revision-change', '/b')
        const other = propose(store, '/b')
        store.review(other.pending.id, true, store.snapshot())
      }
    }
    const next = store.createJob('/a', model, store.snapshot().policyEpoch)
    expect(next.id).not.toBe(initial.id)
    expect(next.evidenceIds).toEqual([source.id])
    const running = store.claimJob(next.id)
    expect(() => store.submit(next.id, running.fence - 1, input(source.id))).toThrow('fence')
    expect(store.submit(next.id, running.fence, input(source.id)).jobId).toBe(next.id)
  },
)
it('still rejects old caller epochs and a non-consented processor before selecting a batch', () => {
  const { store, capture } = fixture()
  capture('source')
  const old = store.snapshot().policyEpoch
  store.setPrefs({ ...prefs, recall: true })
  expect(() => store.createJob('/a', model, old)).toThrow('Stale processing consent')
  expect(() => store.createJob('/a', { provider: 'other', id: 'not-consented' })).toThrow('consent')
})
it('allows a graph-stale rejection using its old graph revision, but not a stale policy', () => {
  const { store, capture } = fixture()
  capture('first')
  const first = propose(store)
  capture('second', '/b')
  const second = propose(store, '/b')
  store.review(second.pending.id, true, store.snapshot())
  store.review(first.pending.id, false, first.pending)
  expect(
    store.snapshot().proposals.find((proposal) => proposal.id === first.pending.id)!.state,
  ).toBe('rejected')
})
it('maximum legal proposal rows remain whole and reachable while other snapshot sections keep room', () => {
  const { store, data, capture } = fixture()
  const source = capture('source')
  const { pending } = propose(store)
  const maximum = {
    ...pending.input,
    claims: Array.from({ length: 100 }, () => ({
      ...pending.input.claims[0]!,
      summary: 's'.repeat(7900),
    })),
  }
  let remaining = 1_000_000 - Buffer.byteLength(JSON.stringify(maximum))
  for (const claim of maximum.claims) {
    const count = Math.min(8000 - claim.literal!.length, remaining)
    claim.literal += 'l'.repeat(count)
    remaining -= count
  }
  expect(remaining).toBe(0)
  validateProposal(maximum)
  for (let index = 0; index < 8; index++) {
    const id = `maximum-${index}`
    data.put('proposals', id, pending.scope, {
      ...pending,
      id,
      createdAt: 2000 + index,
      input: maximum,
    })
  }
  capture('live', '/b')
  const live = store.claimJob(store.createJob('/b', model).id)
  const seen = new Set<string>()
  for (let page = 0; page < 9; page++) {
    const snapshot = store.snapshot()
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(8_600_000)
    expect(snapshot.evidence.some((item) => item.id === source.id)).toBe(true)
    expect(snapshot.jobs[0]!.id).toBe(live.id)
    const visible = snapshot.proposals.filter((proposal) => proposal.state === 'pending')
    if (!visible.length) break
    for (const proposal of visible) {
      if (proposal.id.startsWith('maximum-')) expect(proposal.input).toEqual(maximum)
      seen.add(proposal.id)
      store.review(proposal.id, false, snapshot)
    }
  }
  expect(seen.size).toBe(9)
})
