import { basename, dirname } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { unverifiedFiles } from './embedding-files'
import { loadEmbeddingRuntime } from './embedding-runtime'
import { embeddingInput, embeddingThreads } from './model-manifest'

/**
 * Opt-in: runs the real pinned model on the native CPU backend. Point it at a
 * directory holding exactly the manifest's five files; it is never downloaded
 * here. `PHOSPHOR_BRAIN_EMBEDDING_MODEL_DIR=… npx vitest run <this file>`.
 */
const MODEL_DIR = process.env.PHOSPHOR_BRAIN_EMBEDDING_MODEL_DIR

describe.skipIf(!MODEL_DIR)('EmbeddingGemma q4 on the native runtime', () => {
  const realFetch = globalThis.fetch
  const attempts: string[] = []
  globalThis.fetch = (input: string | URL | Request) => {
    attempts.push(String(input instanceof Request ? input.url : input))
    return Promise.reject(new Error('network refused by the test'))
  }
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  it('verifies, loads locally, and ranks the matching document first', async () => {
    const dir = MODEL_DIR!
    expect(await unverifiedFiles(dir)).toEqual([])
    const runtime = await loadEmbeddingRuntime(
      { modelRoot: dirname(dir), modelName: basename(dir), threads: embeddingThreads(8) },
      await import('@huggingface/transformers'),
    )
    const docs = [
      'The billing team owns the invoice service and reviews schema changes.',
      'The nightly deploy pipeline pushes to the staging cluster at 02:00 UTC.',
      'The onboarding tour was removed because most users skipped it.',
    ]
    const docVectors = await runtime.embed(docs.map((text) => embeddingInput(text, 'document')))
    const [query] = await runtime.embed([
      embeddingInput('Why was the first-run walkthrough taken out?', 'query'),
    ])
    for (const vector of [...docVectors, query!]) {
      expect(vector).toHaveLength(768)
      expect(Math.hypot(...vector)).toBeCloseTo(1, 4)
    }
    const scores = docVectors.map((doc) => doc.reduce((sum, v, i) => sum + v * query![i]!, 0))
    expect(scores.indexOf(Math.max(...scores))).toBe(2)
    expect(attempts).toEqual([])
    await runtime.dispose()
  }, 60_000)
})
