// Opt-in: scores engine A (lexical + typed graph), engine B (local-vector RRF +
// graph) and the raw-transcript FTS5/BM25 baseline on the frozen synthetic
// corpus. B needs real EmbeddingGemma q4 vectors, produced outside this
// package by the Desktop embedding utility process from local model files and
// passed in as a receipt; it is skipped without one. Nothing here asserts a
// quality threshold: labels are frozen and the report is written, not tuned.
//
//   PHOSPHOR_BRAIN_EVAL_VECTORS=<receipt.json> PHOSPHOR_BRAIN_EVAL_REPORT=<out.json> \
//     npx vitest run libs/memory-engine/src/retrieval-eval.native.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { buildEvalStore, loadEvalFixture } from './__fixtures__/retrieval-eval-store'
import { createBaseline } from './__fixtures__/retrieval-eval-score'
import {
  attachVectors,
  checkReceipt,
  evaluate,
  type EmbeddingReceipt,
} from './__fixtures__/retrieval-eval-report'

const RECEIPT = process.env.PHOSPHOR_BRAIN_EVAL_VECTORS
const REPORT = process.env.PHOSPHOR_BRAIN_EVAL_REPORT

describe.skipIf(!RECEIPT)(
  'Brain retrieval evaluation on local EmbeddingGemma vectors (opt-in: set PHOSPHOR_BRAIN_EVAL_VECTORS)',
  () => {
    it('scores A, B and the raw-transcript baseline on every frozen query', () => {
      const { fixture, sha256 } = loadEvalFixture()
      const receipt = JSON.parse(readFileSync(RECEIPT!, 'utf8')) as EmbeddingReceipt
      checkReceipt(receipt, fixture, sha256)
      const directory = mkdtempSync(join(tmpdir(), 'brain-retrieval-eval-'))
      const built = buildEvalStore(fixture, directory, DatabaseSync)
      const baseline = createBaseline(fixture, DatabaseSync)
      try {
        const storedVectors = attachVectors(built, receipt)
        const report = evaluate(fixture, built, baseline, receipt)
        if (REPORT)
          writeFileSync(
            REPORT,
            `${JSON.stringify({ fixtureSha256: sha256, modelId: receipt.modelId, storedVectors, ...report }, null, 2)}\n`,
          )
        expect(report.rows).toHaveLength(fixture.queries.length)
        expect(Object.keys(report.evidenceLevel).sort()).toEqual(['A', 'B', 'baseline'])
        expect(storedVectors).toBeGreaterThan(0)
      } finally {
        baseline.close()
        built.store.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }, 120_000)
  },
)
