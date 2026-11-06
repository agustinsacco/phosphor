import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { BrainCapture, BrainProposalInput } from '@phosphor/shared/brain'
import { openMemoryStore } from './service'

const model = { provider: 'test', id: 'reasoner' }
const prefs = {
  enabled: true,
  recall: true,
  workspaces: ['/a', '/b'],
  processor: model,
  retentionDays: 30,
}
const input: BrainCapture = {
  scope: '/a',
  sessionId: 'lane',
  entryId: 'one',
  parentId: null,
  rootIds: ['root'],
  branch: null,
  role: 'user',
  label: 'Source',
  observedAt: -100000000,
  text: 'Alice owns Project. Project depends on Library. Library affects Customer. Customer blocks Team.',
}
const cleanups: (() => void)[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'brain-invariants-'))
  let now = 1000
  const stores: ReturnType<typeof openMemoryStore>[] = []
  const open = () => {
    const store = openMemoryStore({ directory, Database: DatabaseSync, now: () => now })
    stores.push(store)
    return store
  }
  const store = open()
  store.setPrefs(prefs)
  cleanups.push(() => {
    stores.forEach((store) => store.close())
    rmSync(directory, { force: true, recursive: true })
  })
  return {
    store,
    open,
    directory,
    time: (value: number) => {
      now = value
    },
  }
}
function extraction(id: string, alias = 'Al'): BrainProposalInput {
  return {
    entities: [
      { key: 'alice', label: 'Alice', kind: 'person', aliases: [alias], evidenceIds: [id] },
      { key: 'project', label: 'Project', kind: 'project', aliases: [], evidenceIds: [id] },
    ],
    claims: [
      {
        subject: 'alice',
        predicate: 'owns',
        object: 'project',
        summary: 'Alice owns Project',
        kind: 'reported',
        citations: [{ evidenceId: id, quote: 'Alice owns Project' }],
        validFrom: 0,
        validTo: null,
      },
    ],
    rationale: 'Source',
  }
}
function process(
  store: ReturnType<typeof openMemoryStore>,
  scope: string,
  proposal: BrainProposalInput,
) {
  const job = store.claimJob(store.createJob(scope, model).id)
  const pending = store.submit(job.id, job.fence, proposal)
  const revision = store.snapshot()
  store.review(pending.id, true, revision)
  return { job, pending, revision }
}
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

it('regression: exact submit retries after approval are idempotent, not stale writes', () => {
  const { store } = fixture()
  const evidence = store.capture(input)!
  const proposal = extraction(evidence.id)
  const { job, pending } = process(store, '/a', proposal)
  expect(store.submit(job.id, job.fence, proposal)).toEqual({ ...pending, state: 'applied' })
  expect(store.snapshot().claims).toHaveLength(1)
})
it('regression: new aliases do not leak through a historical knownAt query', () => {
  const { store, time } = fixture()
  const evidence = store.capture(input)!
  process(store, '/a', extraction(evidence.id))
  time(2000)
  const later = store.capture({ ...input, entryId: 'two', rootIds: ['second'] })!
  process(store, '/a', extraction(later.id, 'FutureAlias'))
  expect(
    store.search({ query: 'FutureAlias', knownAt: 1500, mode: 'lexical' }, ['/a']).results,
  ).toHaveLength(0)
  expect(
    store.search({ query: 'FutureAlias', knownAt: 2000, mode: 'lexical' }, ['/a']).results.length,
  ).toBeGreaterThan(0)
})
it('regression: repeated independent-root copies do not create duplicate claims on another job', () => {
  const { store } = fixture()
  const evidence = store.capture(input)!
  process(store, '/a', extraction(evidence.id))
  const fork = store.capture({ ...input, sessionId: 'fork', entryId: 'copy' })!
  process(store, '/a', extraction(fork.id))
  expect(store.snapshot().claims).toHaveLength(1)
})
it('expires by ingestion time, hides expired evidence while open, and persists processor purge receipts', () => {
  const { store, time, open } = fixture()
  const evidence = store.capture(input)!
  const job = store.claimJob(store.createJob('/a', model).id)
  store.updateJob(job.id, job.fence, { sessionPath: '/owned/processor.jsonl' })
  time(86_401_001)
  expect(store.read(evidence.id, ['/a']).id).toBe(evidence.id)
  store.setPrefs({ ...prefs, retentionDays: 1 })
  expect(() => store.read(evidence.id, ['/a'])).toThrow()
  expect(store.pendingPurges()).toEqual([{ jobId: job.id, sessionPath: '/owned/processor.jsonl' }])
  expect(store.capture(input)).toBeNull()
  store.close()
  const restarted = open()
  expect(restarted.pendingPurges()).toHaveLength(1)
  restarted.acknowledgePurge(job.id)
  restarted.acknowledgePurge(job.id)
  expect(restarted.pendingPurges()).toHaveLength(0)
})
it('applies validity AND knowledge filters before 2-hop relation expansion and scope isolation', () => {
  const { store } = fixture()
  const evidence = store.capture(input)!
  const proposal = extraction(evidence.id)
  for (const [key, label] of [
    ['library', 'Library'],
    ['customer', 'Customer'],
    ['team', 'Team'],
  ]) {
    proposal.entities.push({
      key: key!,
      label: label!,
      kind: 'concept',
      aliases: [],
      evidenceIds: [evidence.id],
    })
  }
  proposal.claims.push(
    {
      subject: 'project',
      predicate: 'depends_on',
      object: 'library',
      summary: 'Project depends on Library',
      kind: 'reported',
      citations: [{ evidenceId: evidence.id, quote: 'Project depends on Library' }],
      validFrom: 0,
      validTo: null,
    },
    {
      subject: 'library',
      predicate: 'affects',
      object: 'customer',
      summary: 'Library affects Customer',
      kind: 'reported',
      citations: [{ evidenceId: evidence.id, quote: 'Library affects Customer' }],
      validFrom: 2000,
      validTo: null,
    },
    {
      subject: 'customer',
      predicate: 'blocks',
      object: 'team',
      summary: 'Customer blocks Team',
      kind: 'reported',
      citations: [{ evidenceId: evidence.id, quote: 'Customer blocks Team' }],
      validFrom: 0,
      validTo: null,
    },
  )
  process(store, '/a', proposal)
  const result = store.search({ query: 'Al', mode: 'lexical', validAt: 1000, tokenBudget: 16000 }, [
    '/a',
  ])
  expect(result.results.map((hit) => hit.claim.predicate).sort()).toEqual(['depends_on', 'owns'])
  expect(result.results.find((hit) => hit.claim.predicate === 'depends_on')?.reasons).toContain(
    'relationship',
  )
  expect(
    store.search({ query: 'Al', mode: 'lexical', knownAt: 999, validAt: 1000 }, ['/a']).results,
  ).toHaveLength(0)
  const privateEvidence = store.capture({ ...input, scope: '/b' })!
  process(store, '/b', extraction(privateEvidence.id))
  expect(
    store
      .search({ query: 'Al', mode: 'lexical', scopes: ['/a', '/b'], tokenBudget: 16000 }, ['/a'])
      .results.every((hit) => hit.claim.scope === '/a'),
  ).toBe(true)
  expect(
    store
      .graph(
        store
          .snapshot()
          .entities.find((entity) => entity.scope === '/a' && entity.label === 'Alice')!.id,
      )
      .edges.some((claim) => claim.predicate === 'blocks'),
  ).toBe(false)
})
it('checks evidence integrity and restrictive blob/database modes without inventing snippets', () => {
  const { store, directory } = fixture()
  const evidence = store.capture(input)!
  process(store, '/a', extraction(evidence.id))
  const file = join(directory, 'evidence', readdirSync(join(directory, 'evidence'))[0]!)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(join(directory, 'memory.sqlite')).mode & 0o777).toBe(0o600)
  expect(readFileSync(file, 'utf8')).toBe(input.text)
  writeFileSync(file, 'tampered')
  expect(() => store.read(evidence.id, ['/a'])).toThrow('integrity')
  const result = store.search({ query: 'Alice', mode: 'lexical' }, ['/a'])
  expect(result.results).toHaveLength(0)
  expect(result.status).toBe('partial')
})

it('regression: historical claims retain the pre-correction state and revision', () => {
  const { store, time } = fixture()
  const evidence = store.capture(input)!
  process(store, '/a', extraction(evidence.id))
  const original = store.snapshot().claims[0]!
  time(2000)
  store.correct(
    original.id,
    {
      subjectId: original.subjectId,
      predicate: original.predicate,
      objectId: original.objectId,
      literal: null,
      summary: 'Ownership corrected',
      validFrom: 2000,
      validTo: null,
      reason: 'Human verified',
    },
    store.snapshot(),
  )
  const historical = store.search({ query: 'Al', knownAt: 1500, validAt: 1000, mode: 'lexical' }, [
    '/a',
  ])
  expect(historical.results[0]!.claim).toEqual(original)
})
it('regression: forgetting a root deletes its copies, not an independent co-cited root', () => {
  const { store } = fixture()
  const first = store.capture(input)!
  const independent = store.capture({
    ...input,
    entryId: 'independent',
    rootIds: ['independent-root'],
  })!
  const derived = store.capture({
    ...input,
    entryId: 'derived',
    rootIds: ['root', 'independent-root'],
  })!
  const forgotten = store.forget([first.id])
  expect(forgotten.evidence).toBe(2)
  expect(() => store.read(derived.id, ['/a'])).toThrow()
  expect(store.read(independent.id, ['/a']).id).toBe(independent.id)
  expect(
    store.capture({ ...input, entryId: 'independent-new', rootIds: ['independent-root'] }),
  ).not.toBeNull()
  expect(
    store.capture({ ...input, entryId: 'derived-new', rootIds: ['root', 'independent-root'] }),
  ).toBeNull()
})
it('checks source existence and consent again at approval, and rejects stale parallel proposals', () => {
  const { store } = fixture()
  const first = store.capture(input)!
  const second = store.capture({ ...input, scope: '/b' })!
  const jobA = store.claimJob(store.createJob('/a', model).id)
  const pendingA = store.submit(jobA.id, jobA.fence, extraction(first.id))
  const jobB = store.claimJob(store.createJob('/b', model).id)
  const pendingB = store.submit(jobB.id, jobB.fence, extraction(second.id))
  store.review(pendingA.id, true, store.snapshot())
  expect(() => store.review(pendingB.id, true, store.snapshot())).toThrow('Stale')
  expect(() => store.submit(jobB.id, jobB.fence - 1, extraction(second.id))).toThrow()
  store.forget([second.id])
  expect(() => store.review(pendingB.id, true, store.snapshot())).toThrow()
})
it('rejects cross-scope existing IDs, missing vectors and incompatible dimensions honestly', () => {
  const { store } = fixture()
  const source = store.capture(input)!
  process(store, '/a', extraction(source.id))
  const claim = store.snapshot().claims[0]!
  const other = store.capture({ ...input, scope: '/b' })!
  const job = store.claimJob(store.createJob('/b', model).id)
  const bad = extraction(other.id)
  bad.entities[0]!.existingId = claim.subjectId
  expect(() => store.submit(job.id, job.fence, bad)).toThrow('scope')
  store.putVectors([{ claimId: claim.id, modelId: 'local', values: [1, 0] }])
  expect(() =>
    store.putVectors([{ claimId: claim.id, modelId: 'local', values: [1, 0, 0] }]),
  ).toThrow('dimensions')
  expect(() =>
    store.putVectors([{ claimId: claim.id, modelId: 'local', values: [0, 0] }]),
  ).toThrow()
  const result = store.search({ query: 'Al', mode: 'hybrid' }, ['/a'], {
    modelId: 'missing',
    values: [1, 0],
  })
  expect(result.status).toBe('partial')
  expect(result.degradation.join()).toContain('vectors')
})
it('expires during an open app on search without a preferences change or scheduler', () => {
  const { store, time } = fixture()
  const source = store.capture(input)!
  process(store, '/a', extraction(source.id))
  time(31 * 86_400_000)
  expect(store.search({ query: 'Al', mode: 'lexical' }, ['/a']).results).toHaveLength(0)
  expect(store.snapshot().counts.evidence).toBe(0)
  expect(store.capture(input)).toBeNull()
})
