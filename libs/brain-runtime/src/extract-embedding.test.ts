import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { fixture } from '@phosphor/memory-engine/test-support'
import { pipelineSetup, answerFor } from './__fixtures__/pipeline'
import { extractJob } from './extract'
import { EMBEDDING_MAX_TEXTS } from './embedding/model-manifest'

it('batches 257 distinct claims and entity cards without losing a review item', async () => {
  const s = await pipelineSetup()
  afterEach(s.cleanup)
  const { store } = fixture()
  const statements = Array.from({ length: 257 }, (_, i) => `Harbor module ${i + 1} is ready.`)
  await writeFile(
    s.file,
    [
      ...s.entries.slice(0, 3),
      {
        type: 'message',
        id: 'B',
        message: { role: 'user', content: statements.join('\n') },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n'),
  )
  s.runner.mockImplementation(async (input) => ({
    text:
      input.stage === 'extract'
        ? JSON.stringify({
            entities: statements.map((_s, i) => ({
              ref: `n${i + 1}`,
              label: `Harbor module ${i + 1}`,
              kind: 'concept',
              aliases: [],
              description: '',
              keys: [],
            })),
            claims: statements.map((text, i) => ({
              ref: `c${i + 1}`,
              text,
              type: 'fact',
              epistemic: 'reported',
              mentions: [`n${i + 1}`],
              links: [],
              quotes: [{ segment: 's1', quote: text }],
              branch: false,
              validFrom: null,
              validTo: null,
            })),
            parents: [],
          })
        : answerFor(input),
    usage: { tokens: 1, cost: 0 },
  }))
  const job = store.enqueue(s.job, 'queued')
  await expect(
    extractJob(job, new AbortController().signal, store, s.options, s.search),
  ).resolves.toBeUndefined()
  expect(store.job(job.id)?.state).toBe('review')
  const proposal = store.storedProposal(job.id)!
  expect(proposal.memories.map((m) => m.summary)).toEqual(statements)
  expect(proposal.memoryVectors).toHaveLength(257)
  expect(proposal.entities).toHaveLength(257)
  expect(proposal.entityVectors).toHaveLength(257)
  // The shared fake rejects oversize requests, just like Desktop's controller.
  await expect(
    s.options.embeddings.embed(Array(EMBEDDING_MAX_TEXTS + 1).fill('text'), 'document'),
  ).rejects.toThrow('256')
})
