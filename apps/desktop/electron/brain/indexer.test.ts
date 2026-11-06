import { afterEach, expect, it, vi } from 'vitest'
import { BRAIN_EMBEDDING_MODEL } from '@phosphor/shared/brain'
import { adapterFixture, deferred } from './__fixtures__/adapter-fixture'
import { createBrainIndexer } from './indexer'

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
