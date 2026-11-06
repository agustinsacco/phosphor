// Runs every fixture query through A, B and the baseline and aggregates the
// scores. Vectors come from an embeddings receipt written outside this
// package by the Desktop embedding utility process (EmbeddingGemma q4, local
// files only); this module only checks the receipt matches the frozen fixture.
import { BRAIN_EMBEDDING_MODEL } from '@phosphor/shared/brain'
import {
  allClaims,
  type EvalFixture,
  type EvalQuery,
  type EvalStore,
  type EvalViolation,
} from './retrieval-eval-store'
import {
  claimLabels,
  engineRun,
  evidenceLabels,
  scoreQuery,
  type QueryScore,
  type Ranked,
} from './retrieval-eval-score'

export interface EmbeddingReceipt {
  fixtureSha256: string
  modelId: string
  dimensions: number
  prefixes: { query: string; document: string }
  /** Raw claim summary or query text -> unit vector of the prefixed text. */
  documents: Record<string, number[]>
  queries: Record<string, number[]>
}
export interface Summary {
  queries: number
  answerable: number
  top1: number
  recall5: number
  recall10: number
  noGold: number
  abstained: number
  /** Queries with at least one forbidden item anywhere in the returned list. */
  violations: Record<EvalViolation, number>
  ms: { median: number; p95: number; max: number }
  byCategory: Record<string, { n: number; top1: number; recall5: number; violations: number }>
}

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

export function summarize(scores: QueryScore[]): Summary {
  const answerable = scores.filter((score) => score.gold > 0)
  const violations = { branch: 0, temporal: 0, scope: 0 }
  for (const why of Object.keys(violations) as EvalViolation[])
    violations[why] = scores.filter((s) => s.violations.some((v) => v.why === why)).length
  const byCategory: Summary['byCategory'] = {}
  for (const category of unique(scores.map((score) => score.category))) {
    const group = scores.filter((score) => score.category === category)
    const graded = group.filter((score) => score.gold > 0)
    byCategory[category] = {
      n: group.length,
      top1: graded.filter((score) => score.top1).length,
      recall5: mean(graded.map((score) => score.recall5!)),
      violations: group.filter((score) => score.violations.length).length,
    }
  }
  const ms = scores.map((score) => score.ms)
  return {
    queries: scores.length,
    answerable: answerable.length,
    top1: answerable.filter((score) => score.top1).length,
    recall5: mean(answerable.map((score) => score.recall5!)),
    recall10: mean(answerable.map((score) => score.recall10!)),
    noGold: scores.length - answerable.length,
    abstained: scores.filter((score) => score.gold === 0 && score.returned === 0).length,
    violations,
    ms: { median: quantile(ms, 0.5), p95: quantile(ms, 0.95), max: Math.max(...ms) },
    byCategory,
  }
}
const unique = <T>(items: T[]) => [...new Set(items)]

/** Throws unless the receipt was made for these fixture bytes and holds every text, finite and unit-length. */
export function checkReceipt(receipt: EmbeddingReceipt, fixture: EvalFixture, sha256: string) {
  const fail = (message: string) => new Error(`Embedding receipt: ${message}`)
  if (receipt.fixtureSha256 !== sha256) throw fail('made for different fixture bytes')
  if (receipt.modelId !== BRAIN_EMBEDDING_MODEL.id)
    throw fail(`unexpected model ${receipt.modelId}`)
  const vectors = [
    ...allClaims(fixture).map((claim) => receipt.documents[claim.summary]),
    ...fixture.queries.map((query) => receipt.queries[query.text]),
  ]
  for (const vector of vectors) {
    if (!vector || vector.length !== BRAIN_EMBEDDING_MODEL.dimensions) throw fail('missing vector')
    if (!vector.every(Number.isFinite)) throw fail('non-finite vector')
    if (Math.abs(Math.hypot(...vector) - 1) > 1e-3) throw fail('vector is not unit length')
  }
}

/** Stores a document vector for every claim the engine asks to embed. */
export function attachVectors(built: EvalStore, receipt: EmbeddingReceipt): number {
  let stored = 0
  for (;;) {
    const items = built.store.embeddingItems(receipt.modelId, 200)
    if (!items.length) return stored
    built.store.putVectors(
      items.map((item) => {
        const values = receipt.documents[item.text]
        if (!values) throw new Error(`No receipt vector for claim text: ${item.text}`)
        return { claimId: item.claimId, modelId: receipt.modelId, values }
      }),
    )
    stored += items.length
  }
}

export interface QueryRow {
  query: EvalQuery
  runs: Record<string, Ranked>
}
export interface EvalReport {
  rows: QueryRow[]
  claimLevel: Record<string, Summary>
  evidenceLevel: Record<string, Summary>
  scores: Record<string, QueryScore[]>
}

export function evaluate(
  fixture: EvalFixture,
  built: EvalStore,
  baseline: { search(query: EvalQuery): Ranked },
  receipt?: EmbeddingReceipt,
): EvalReport {
  const rows: QueryRow[] = fixture.queries.map((query) => {
    const runs: Record<string, Ranked> = {
      A: engineRun(built, fixture, query, 'lexical'),
      baseline: baseline.search(query),
    }
    if (receipt)
      runs.B = engineRun(built, fixture, query, 'hybrid', {
        modelId: receipt.modelId,
        values: receipt.queries[query.text]!,
      })
    return { query, runs }
  })
  const systems = Object.keys(rows[0]?.runs ?? {})
  const scores: Record<string, QueryScore[]> = {}
  const claimLevel: Record<string, Summary> = {}
  const evidenceLevel: Record<string, Summary> = {}
  for (const system of systems) {
    const claim = rows.map(({ query, runs }) =>
      scoreQuery(query, runs[system]!.claims, claimLabels(query), runs[system]!.ms),
    )
    const evidence = rows.map(({ query, runs }) =>
      scoreQuery(query, runs[system]!.evidence, evidenceLabels(fixture, query), runs[system]!.ms),
    )
    scores[`${system}:claim`] = claim
    scores[`${system}:evidence`] = evidence
    if (system !== 'baseline') claimLevel[system] = summarize(claim)
    evidenceLevel[system] = summarize(evidence)
  }
  return { rows, claimLevel, evidenceLevel, scores }
}
