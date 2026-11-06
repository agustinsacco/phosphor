import { afterEach, expect, it, vi } from 'vitest'
import { BRAIN_EMBEDDING_MODEL } from '@phosphor/shared/brain'
import { adapterFixture, deferred } from './__fixtures__/adapter-fixture'
import { createBrainIndexer } from './indexer'

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))
const { assembleBrainService } = await import('./service')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function reviewedFixture() {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const job = f.engine.claimJob(f.engine.createJob(f.scope, f.model, f.snapshot.policyEpoch).id)
  const proposal = f.engine.submit(job.id, job.fence, {
    entities: [
      {
        key: 'atlas',
        label: 'Atlas',
        kind: 'component',
        aliases: [],
        evidenceIds: [f.evidence.id],
      },
    ],
    claims: [
      {
        subject: 'atlas',
        predicate: 'depends_on',
        literal: 'Mercury',
        summary: 'Atlas depends on Mercury',
        kind: 'reported',
        citations: [{ evidenceId: f.evidence.id, quote: 'Atlas depends on Mercury' }],
        validFrom: null,
        validTo: null,
      },
    ],
    rationale: 'Grounded in the user message',
  })
  f.engine.review(proposal.id, true, f.engine.snapshot())
  const embeddings = {
    ...f.embeds,
    status: () => ({
      phase: 'ready' as const,
      receivedBytes: 0,
      totalBytes: 0,
      modelId: BRAIN_EMBEDDING_MODEL.id,
      dimensions: 768,
    }),
    embed: vi.fn(async (): Promise<number[][]> => [
      Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
    ]),
  }
  const indexer = createBrainIndexer(f.store, embeddings)
  cleanup.push(async () => indexer.dispose())
  return { ...f, embeddings, indexer }
}
it('indexes only accepted summaries with the pinned local model and reports hybrid semantic hits', async () => {
  const f = await reviewedFixture()
  await f.indexer.index()
  expect(f.embeddings.embed).toHaveBeenCalledWith(
    ['Atlas depends on Mercury'],
    'document',
    expect.any(AbortSignal),
  )
  expect(f.engine.snapshot().counts.vectors).toBe(1)
  const result = await f.indexer.search({ query: 'Atlas', branch: 'main' }, [f.scope])
  expect(result.results[0]!.reasons).toContain('semantic')
})
it.each(['forget', 'policy', 'correction'] as const)(
  'does not restore vectors after %s while local embedding is pending',
  async (change) => {
    const f = await reviewedFixture()
    const pending = deferred<number[][]>()
    f.embeddings.embed.mockReturnValue(pending.promise)
    const indexing = f.indexer.index()
    await vi.waitFor(() => expect(f.embeddings.embed).toHaveBeenCalled())
    if (change === 'forget') f.engine.forget([f.evidence.id])
    else if (change === 'policy') f.engine.setPrefs({ ...f.engine.snapshot().prefs, recall: false })
    else {
      const claim = f.engine.snapshot().claims[0]!
      f.engine.correct(
        claim.id,
        {
          subjectId: claim.subjectId,
          predicate: 'about',
          objectId: null,
          literal: 'Mercury',
          summary: 'Corrected Atlas relationship',
          validFrom: null,
          validTo: null,
          reason: 'Human correction',
        },
        f.engine.snapshot(),
      )
    }
    pending.resolve([Array.from({ length: 768 }, () => 1)])
    await indexing
    expect(f.engine.snapshot().counts.vectors).toBe(0)
  },
)
it('drains a newer explicit indexing request after a stale in-flight completion', async () => {
  const f = await reviewedFixture()
  const pending = deferred<number[][]>()
  f.embeddings.embed.mockReturnValueOnce(pending.promise)
  const first = f.indexer.index()
  await vi.waitFor(() => expect(f.embeddings.embed).toHaveBeenCalledOnce())
  const claim = f.engine.snapshot().claims[0]!
  f.engine.correct(
    claim.id,
    {
      subjectId: claim.subjectId,
      predicate: 'about',
      objectId: null,
      literal: 'Neptune',
      summary: 'Atlas now depends on Neptune',
      validFrom: null,
      validTo: null,
      reason: 'Human correction during local indexing',
    },
    f.engine.snapshot(),
  )
  const next = f.indexer.index()
  pending.resolve([Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))])
  await Promise.all([first, next])
  expect(f.embeddings.embed).toHaveBeenCalledWith(
    ['Atlas now depends on Neptune'],
    'document',
    expect.any(AbortSignal),
  )
  expect(f.engine.snapshot().counts.vectors).toBe(1)
  expect(f.engine.embeddingItems(BRAIN_EMBEDDING_MODEL.id, 8)).toEqual([])
})
it.each(['startup', 'enable'] as const)(
  'indexes reviewed backlog when the local model is ready on %s',
  async (when) => {
    const f = await reviewedFixture()
    if (when === 'enable') f.engine.setPrefs({ ...f.engine.snapshot().prefs, enabled: false })
    const service = await assembleBrainService({ ...f.options, embeddings: f.embeddings }, f.store)
    cleanup.push(() => service.dispose())
    if (when === 'enable') {
      expect(f.embeddings.embed).not.toHaveBeenCalled()
      await service.ui['brain:setPrefs']({ ...f.engine.snapshot().prefs, enabled: true })
    }
    expect(f.engine.snapshot().counts.vectors).toBe(1)
    expect(f.embeddings.download).not.toHaveBeenCalled()
    expect(f.options.sessions.create).not.toHaveBeenCalled()
  },
)
it('returns saved consent despite optional indexing failure and retries on the next request', async () => {
  const f = await reviewedFixture()
  f.engine.setPrefs({ ...f.engine.snapshot().prefs, enabled: false })
  const service = await assembleBrainService({ ...f.options, embeddings: f.embeddings }, f.store)
  cleanup.push(() => service.dispose())
  const failure = new Error('Synthetic local embedding timeout')
  f.embeddings.embed.mockRejectedValueOnce(failure)
  const status = await service.ui['brain:setPrefs']({ ...f.engine.snapshot().prefs, enabled: true })
  expect(status.snapshot.prefs.enabled).toBe(true)
  expect(status.snapshot.policyEpoch).toBe(f.engine.snapshot().policyEpoch)
  expect(f.options.onError).toHaveBeenCalledWith(failure)
  expect(f.engine.snapshot().counts.vectors).toBe(0)
  await service.ui['brain:setPrefs'](status.snapshot.prefs)
  expect(f.engine.snapshot().counts.vectors).toBe(1)
  expect(f.options.sessions.create).not.toHaveBeenCalled()
})

async function conflictingFixture() {
  const f = await reviewedFixture()
  const source = f.engine.capture({
    ...f.evidence,
    entryId: 'conflicting-input',
    rootIds: ['conflicting-input'],
    text: 'Atlas depends on Venus',
  })!
  const job = f.engine.claimJob(
    f.engine.createJob(f.scope, f.model, f.engine.snapshot().policyEpoch).id,
  )
  const proposal = f.engine.submit(job.id, job.fence, {
    entities: [
      { key: 'atlas', label: 'Atlas', kind: 'component', aliases: [], evidenceIds: [source.id] },
    ],
    claims: [
      {
        subject: 'atlas',
        predicate: 'depends_on',
        literal: 'Venus',
        summary: 'Atlas depends on Venus',
        kind: 'reported',
        citations: [{ evidenceId: source.id, quote: source.text }],
        validFrom: null,
        validTo: null,
      },
    ],
    rationale: 'Independent conflicting user evidence',
  })
  f.engine.review(proposal.id, true, f.engine.snapshot())
  const embeddings = {
    ...f.embeddings,
    embed: vi.fn(async (texts: string[]) =>
      texts.map(() => Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))),
    ),
  }
  const service = await assembleBrainService({ ...f.options, embeddings }, f.store)
  cleanup.push(() => service.dispose())
  return { ...f, embeddings, service }
}
it.each([false, true])(
  'rebuilds surviving vectors after forgetting without losing the result on embedding failure=%s',
  async (fails) => {
    const f = await conflictingFixture()
    expect(f.engine.snapshot().claims.map((claim) => claim.state)).toEqual([
      'contested',
      'contested',
    ])
    expect(f.engine.snapshot().counts.vectors).toBe(2)
    const failure = new Error('Synthetic derived indexing failure')
    if (fails) f.embeddings.embed.mockRejectedValueOnce(failure)
    const result = await f.service.ui['brain:forget']([f.evidence.id])
    expect(result.evidence).toBe(1)
    expect(f.engine.snapshot().claims.map((claim) => claim.state)).toEqual(['active'])
    if (fails) {
      expect(f.options.onError).toHaveBeenCalledWith(failure)
      await f.service.ui['brain:setPrefs'](f.engine.snapshot().prefs)
    }
    expect(f.engine.snapshot().counts.vectors).toBe(1)
    expect(f.engine.embeddingItems(BRAIN_EMBEDDING_MODEL.id, 8)).toEqual([])
    expect(f.options.sessions.create).not.toHaveBeenCalled()
  },
)

it('exposes semantic degradation without silently substituting another embedding model', async () => {
  const f = await reviewedFixture()
  f.embeddings.embed.mockRejectedValue(new Error('Model unavailable'))
  const result = await f.indexer.search({ query: 'Atlas', branch: 'main' }, [f.scope])
  expect(result.status).toBe('partial')
  expect(result.results.length).toBeGreaterThan(0)
  expect(result.degradation).toContain(
    'Local semantic retrieval unavailable; lexical and typed graph results only',
  )
})
