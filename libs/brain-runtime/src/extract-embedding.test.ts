import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { pipelineSetup, answerFor } from './__fixtures__/pipeline'
import { extractJob } from './extract'
import { EMBEDDING_MAX_TEXTS } from './embedding/model-manifest'

it('batches 257 entity cards while enforcing the per-part claim limit', async () => {
  const s = await pipelineSetup()
  afterEach(s.cleanup)
  const { store, job } = s
  const statements = Array.from({ length: 257 }, (_, i) => `Harbor module ${i + 1} is ready.`)
  await writeFile(
    s.file,
    [
      ...s.entries.slice(0, 3),
      {
        type: 'message',
        id: 'B',
        message: { role: 'assistant', content: statements.join('\n') },
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
  await expect(
    extractJob(job, new AbortController().signal, store, s.options, s.search),
  ).resolves.toBeUndefined()
  expect(store.job(job.id)?.state).toBe('done')
  const proposal = store.saved.get(job.id)!
  expect(proposal.memories.map((m) => m.summary)).toEqual(statements.slice(0, 25))
  expect(proposal.memoryVectors).toHaveLength(25)
  expect(proposal.entities).toHaveLength(257)
  expect(proposal.entityVectors).toHaveLength(257)
  // The shared fake rejects oversize requests, just like Desktop's controller.
  await expect(
    s.options.embeddings.embed(Array(EMBEDDING_MAX_TEXTS + 1).fill('text'), 'document'),
  ).rejects.toThrow('256')
})
