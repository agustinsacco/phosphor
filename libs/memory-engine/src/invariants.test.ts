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

it('isolates branch-tagged evidence before lexical, vector and relationship recall', () => {
  const { store } = fixture()
  const source = store.capture({ ...input, branch: 'feature' })!
  process(store, '/a', extraction(source.id))
  const claim = store.snapshot().claims[0]!
  store.putVectors([{ claimId: claim.id, modelId: 'local', values: [1, 0] }])
  expect(store.search({ query: 'Al', mode: 'lexical' }, ['/a']).results).toHaveLength(0)
  expect(store.graph().edges).toHaveLength(0)
  const matching = { query: 'Al', mode: 'hybrid' as const, branch: 'feature' }
  const other = { ...matching, branch: 'main' }
  expect(store.search(matching, ['/a'], { modelId: 'local', values: [1, 0] }).results).toHaveLength(
    1,
  )
  expect(store.search(other, ['/a'], { modelId: 'local', values: [1, 0] }).results).toHaveLength(0)
  expect(store.read(source.id, ['/a']).branch).toBe('feature')
  const mixed = store.capture({
    ...input,
    branch: 'main',
    entryId: 'mixed',
    rootIds: ['other-root'],
  })!
  const proposal = extraction(source.id)
  proposal.claims[0]!.summary = 'Mixed branch report'
  proposal.claims[0]!.citations.push({ evidenceId: mixed.id, quote: 'Alice owns Project' })
  process(store, '/a', proposal)
  expect(store.search(matching, ['/a']).results.map((hit) => hit.claim.summary)).not.toContain(
    'Mixed branch report',
  )
})
it('keeps contradictions visible without silently replacing either human-approved claim', () => {
  const { store, time } = fixture()
  const first = store.capture(input)!
  process(store, '/a', extraction(first.id))
  time(2000)
  const next = store.capture({
    ...input,
    entryId: 'contradiction',
    rootIds: ['other-root'],
    text: 'Alice owns Library.',
  })!
  const proposal = extraction(next.id)
  proposal.entities[1]!.label = 'Library'
  proposal.claims[0]!.summary = 'Alice owns Library'
  proposal.claims[0]!.citations[0]!.quote = 'Alice owns Library'
  process(store, '/a', proposal)
  const claims = store.snapshot().claims
  expect(
    claims.every((claim) => claim.state === 'contested' && claim.conflictIds.length === 1),
  ).toBe(true)
  const historical = store.search({ query: 'Al', knownAt: 1500, validAt: 1000, mode: 'lexical' }, [
    '/a',
  ])
  expect(historical.results[0]!.claim.state).toBe('active')
  expect(historical.results[0]!.claim.conflictIds).toEqual([])
})
it('forgets correction evidence and all derived versions, not merely vector indexes', () => {
  const { store } = fixture()
  const first = store.capture(input)!
  process(store, '/a', extraction(first.id))
  const original = store.snapshot().claims[0]!
  const corrected = store.correct(
    original.id,
    {
      subjectId: original.subjectId,
      predicate: original.predicate,
      objectId: original.objectId,
      literal: null,
      summary: 'Corrected ownership',
      validFrom: 0,
      validTo: null,
      reason: 'Human verified',
    },
    store.snapshot(),
  )
  store.forget([first.id])
  expect(() => store.read(corrected.citations[0]!.evidenceId, ['/a'])).toThrow()
  expect(store.snapshot().counts.claims).toBe(0)
  expect(store.snapshot().counts.evidence).toBe(0)
  expect(
    store.search({ query: 'Al', knownAt: 1000, mode: 'lexical' }, ['/a']).results,
  ).toHaveLength(0)
})

it('enforces one processor copy per job, exposes no forgotten transcript path, and permits a new manual job after failure', () => {
  const { store, open } = fixture()
  const source = store.capture(input)!
  const job = store.claimJob(store.createJob('/a', model).id)
  store.updateJob(job.id, job.fence, { sessionPath: '/owned/stamp_processor.jsonl' })
  expect(() => store.updateJob(job.id, job.fence, { sessionPath: '/owned/other.jsonl' })).toThrow(
    'immutable',
  )
  expect(() => store.updateJob(job.id, job.fence, { sessionPath: null })).toThrow('immutable')
  store.updateJob(job.id, job.fence, { state: 'failed', error: 'Visible failure' })
  const next = store.createJob('/a', model)
  expect(next.id).not.toBe(job.id)
  expect(store.createJob('/a', model).id).toBe(next.id)
  store.forget([source.id])
  expect(store.job(job.id).sessionPath).toBeNull()
  expect(store.pendingPurges()).toEqual([
    { jobId: job.id, sessionPath: '/owned/stamp_processor.jsonl' },
  ])
  store.close()
  const restarted = open()
  expect(
    restarted.capture({ ...input, sessionId: 'processor', entryId: 'echo', rootIds: ['fresh'] }),
  ).toBeNull()
})
it('bounds snapshot and graph outputs explicitly, with truncation, while retaining authoritative counts', () => {
  const { store } = fixture()
  const source = store.capture(input)!
  for (let batch = 0; batch < 3; batch++) {
    const entities = Array.from({ length: 100 }, (_, index) => ({
      key: `key-${index}`,
      label: `Entity ${batch}-${index}`,
      kind: 'concept' as const,
      aliases: [],
      evidenceIds: [source.id],
    }))
    const claims = entities.slice(1).map((entity, index) => ({
      subject: entities[index]!.key,
      predicate: 'about' as const,
      object: entity.key,
      summary: `Link ${batch}-${index}`,
      kind: 'reported' as const,
      citations: [{ evidenceId: source.id, quote: 'Alice owns Project' }],
      validFrom: 0,
      validTo: null,
    }))
    process(store, '/a', { entities, claims, rationale: 'Synthetic bound test' })
  }
  const snapshot = store.snapshot()
  expect(snapshot.counts.entities).toBe(300)
  expect(snapshot.entities).toHaveLength(200)
  expect(snapshot.claims).toHaveLength(200)
  expect(snapshot.truncated).toBe(true)
  const graph = store.graph()
  expect(graph.nodes.length).toBeLessThanOrEqual(200)
  expect(graph.truncated).toBe(true)
  expect(
    graph.edges.every(
      (edge) =>
        graph.nodes.some((node) => node.id === edge.subjectId) &&
        graph.nodes.some((node) => node.id === edge.objectId),
    ),
  ).toBe(true)
})
it('expands exactly two typed hops, even when a third and fourth edge are eligible', () => {
  const { store, time } = fixture()
  const source = store.capture(input)!
  const names = ['Alice', 'Project', 'Library', 'Customer', 'Team']
  const entities = names.map((label, index) => ({
    key: String(index),
    label,
    kind: 'concept' as const,
    aliases: index === 0 ? ['Al'] : [],
    evidenceIds: [source.id],
  }))
  const claims = entities.slice(1).map((entity, index) => ({
    subject: String(index),
    predicate: 'about' as const,
    object: entity.key,
    summary: `Relation ${index}`,
    kind: 'reported' as const,
    citations: [{ evidenceId: source.id, quote: 'Alice owns Project' }],
    validFrom: 0,
    validTo: null,
  }))
  process(store, '/a', { entities, claims, rationale: 'Synthetic relationship test' })
  time(3000)
  const recalled = store.search({ query: 'Al', mode: 'lexical', tokenBudget: 16000 }, ['/a'])
  expect(recalled.results.map((hit) => hit.claim.summary).sort()).toEqual([
    'Relation 0',
    'Relation 1',
  ])
  const root = store.snapshot().entities.find((entity) => entity.label === 'Alice')!
  expect(
    store
      .graph(root.id)
      .edges.map((claim) => claim.summary)
      .sort(),
  ).toEqual(['Relation 0', 'Relation 1'])
})

it('regression: correction runtime input cannot override claim scope with untyped fields', () => {
  const { store } = fixture()
  const source = store.capture(input)!
  process(store, '/a', extraction(source.id))
  const claim = store.snapshot().claims[0]!
  const correction = {
    subjectId: claim.subjectId,
    predicate: claim.predicate,
    objectId: claim.objectId,
    literal: claim.literal,
    summary: 'Corrected',
    validFrom: 0,
    validTo: null,
    reason: 'Human',
    scope: '/b',
  }
  expect(() => store.correct(claim.id, correction, store.snapshot())).toThrow()
  expect(store.snapshot().claims.every((item) => item.scope === '/a')).toBe(true)
})

it('regression: forgetting removes deleted summaries from retained FTS segment bytes', () => {
  const { store, directory } = fixture()
  const source = store.capture(input)!
  const proposal = extraction(source.id)
  const marker = 'UNIQUE_FORGOTTEN_FTS_SUMMARY_98213476'
  proposal.claims[0]!.summary = marker
  process(store, '/a', proposal)
  store.forget([source.id])
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from(marker))).toBe(false)
})
it('regression: a rejected proposal permits a fresh explicit processing attempt', () => {
  const { store } = fixture()
  const source = store.capture(input)!
  const job = store.claimJob(store.createJob('/a', model).id)
  const pending = store.submit(job.id, job.fence, extraction(source.id))
  store.review(pending.id, false, store.snapshot())
  const next = store.createJob('/a', model)
  expect(next.id).not.toBe(job.id)
  expect(next.state).toBe('queued')
})
it('regression: forgetting removes lowercased FTS index terms, not only content rows', () => {
  const { store, directory } = fixture()
  const source = store.capture(input)!
  const proposal = extraction(source.id)
  const marker = 'uniqueforgottenftsterm98213476'
  proposal.claims[0]!.summary = marker
  process(store, '/a', proposal)
  store.forget([source.id])
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from(marker))).toBe(false)
})
