// Deterministic checks for the synthetic retrieval evaluation: the frozen
// fixture is well formed, builds into a real store in the designed states, and
// the harness mechanics (labels, metrics, baseline filters, receipt checks)
// behave as defined. No system is scored here; the opt-in scoring run is
// retrieval-eval.native.test.ts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BRAIN_EMBEDDING_MODEL } from '@phosphor/shared/brain'
import {
  allClaims,
  buildEvalStore,
  loadEvalFixture,
  type EvalQuery,
  type EvalStore,
} from './__fixtures__/retrieval-eval-store'
import { createBaseline, evidenceLabels, scoreQuery } from './__fixtures__/retrieval-eval-score'
import { checkReceipt, type EmbeddingReceipt } from './__fixtures__/retrieval-eval-report'

const { fixture, sha256 } = loadEvalFixture()
const claims = new Map(allClaims(fixture).map((claim) => [claim.key, claim]))
const evidence = new Map(fixture.evidence.map((item) => [item.key, item]))
const directories: string[] = []
const stores: EvalStore[] = []
afterEach(() => {
  for (const built of stores.splice(0)) built.store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function build(): EvalStore {
  const directory = mkdtempSync(join(tmpdir(), 'brain-retrieval-eval-'))
  directories.push(directory)
  const built = buildEvalStore(fixture, directory, DatabaseSync)
  stores.push(built)
  return built
}
const scopeOf = (key: string) => fixture.jobs.find((job) => job.claims.some((c) => c.key === key))!

describe('synthetic retrieval evaluation fixture', () => {
  it('is a modest synthetic corpus with unique keys and every category', () => {
    expect(claims.size).toBeGreaterThanOrEqual(20)
    expect(claims.size).toBeLessThanOrEqual(30)
    expect(allClaims(fixture)).toHaveLength(claims.size)
    expect(fixture.queries.length).toBeGreaterThanOrEqual(30)
    expect(fixture.queries.length).toBeLessThanOrEqual(40)
    expect(new Set(fixture.queries.map((query) => query.id)).size).toBe(fixture.queries.length)
    expect(evidence.size).toBe(fixture.evidence.length)
    expect(new Set(fixture.queries.map((query) => query.category))).toEqual(
      new Set([
        'paraphrase',
        'lexical',
        'alias',
        'relationship',
        'branch',
        'temporal',
        'conflict',
        'unanswerable',
        'scope',
      ]),
    )
    expect(fixture.allowedScopes.every((scope) => fixture.scopes.includes(scope))).toBe(true)
  })

  it('cites only verbatim quotes from same-scope evidence that exists by then', () => {
    for (const job of fixture.jobs)
      for (const claim of job.claims)
        for (const citation of claim.citations) {
          const source = evidence.get(citation.evidence)!
          expect(source.text, claim.key).toContain(citation.quote)
          expect(source.scope, claim.key).toBe(job.scope)
          expect(source.phase, claim.key).toBeLessThanOrEqual(job.phase)
        }
  })

  it('labels only existing claims, never one claim as both gold and forbidden', () => {
    for (const query of fixture.queries) {
      const forbidden = query.forbid.map((entry) => entry.claim)
      for (const key of [...query.gold, ...forbidden]) expect(claims.has(key), query.id).toBe(true)
      expect(
        query.gold.filter((key) => forbidden.includes(key)),
        query.id,
      ).toEqual([])
    }
  })

  it('forbids by reason only claims that have that reason', () => {
    const branchClaim = (key: string) =>
      claims.get(key)!.citations.some((c) => evidence.get(c.evidence)!.branch !== null)
    for (const query of fixture.queries)
      for (const { claim, why } of query.forbid) {
        if (why === 'branch') expect(branchClaim(claim), query.id).toBe(true)
        if (why === 'scope')
          expect(fixture.allowedScopes, query.id).not.toContain(scopeOf(claim).scope)
        if (why === 'temporal') expect(branchClaim(claim), query.id).toBe(false)
      }
  })
})

describe('synthetic retrieval evaluation store', () => {
  it('applies every claim through review in the designed states', () => {
    const built = build()
    expect(built.claimIds.size).toBe(claims.size)
    expect(built.evidenceIds.size).toBe(evidence.size)
    const snapshot = built.store.snapshot()
    const state = (key: string) =>
      snapshot.claims.find((claim) => claim.id === built.claimIds.get(key))!.state
    expect(state('c13')).toBe('superseded')
    for (const key of ['c07', 'c08', 'c09', 'c10']) expect(state(key), key).toBe('contested')
    const designed = new Set(['c13', 'c07', 'c08', 'c09', 'c10'])
    for (const key of claims.keys()) if (!designed.has(key)) expect(state(key), key).toBe('active')
    expect(built.clock.now).toBe(fixture.clock.query)
  })
})

describe('synthetic retrieval evaluation harness', () => {
  const query = (overrides: Partial<EvalQuery>): EvalQuery => ({
    id: 'x',
    category: 'lexical',
    text: 'Ledger v2 migration',
    gold: [],
    forbid: [],
    ...overrides,
  })

  it('scores rank, recall and forbidden items anywhere in the returned list', () => {
    const labels = { gold: ['g', 'h'], forbid: [{ item: 'f', why: 'branch' as const }] }
    expect(scoreQuery(query({}), ['x', 'g', 'f'], labels, 3)).toMatchObject({
      top1: false,
      recall5: 0.5,
      firstGold: 2,
      returned: 3,
      violations: [{ item: 'f', why: 'branch', rank: 3 }],
    })
    expect(scoreQuery(query({}), [], { gold: [], forbid: [] }, 0)).toMatchObject({
      top1: null,
      recall5: null,
      returned: 0,
    })
  })

  it('derives evidence labels from citations, never forbidding gold evidence', () => {
    const t01 = fixture.queries.find((entry) => entry.id === 't01')!
    expect(evidenceLabels(fixture, t01)).toEqual({
      gold: ['E19'],
      forbid: [{ item: 'E01', why: 'temporal' }],
    })
  })

  it('filters the raw-transcript baseline by scope, branch and knownAt only', () => {
    const baseline = createBaseline(fixture, DatabaseSync)
    try {
      expect(baseline.search(query({})).evidence).not.toContain('E14')
      expect(baseline.search(query({ branch: 'feature/ledger-v2' })).evidence).toContain('E14')
      expect(baseline.search(query({ text: 'Atlas Logistics' })).evidence).toEqual([])
      const train = query({ text: 'Release train' })
      expect(baseline.search(train).evidence).toContain('E18')
      expect(baseline.search({ ...train, knownAt: 2000 }).evidence).not.toContain('E18')
      expect(baseline.search(query({ text: '?!' })).evidence).toEqual([])
    } finally {
      baseline.close()
    }
  })

  it('refuses an embeddings receipt made for other fixture bytes or missing a text', () => {
    const unit = [1, ...Array<number>(BRAIN_EMBEDDING_MODEL.dimensions - 1).fill(0)]
    const receipt: EmbeddingReceipt = {
      fixtureSha256: sha256,
      modelId: BRAIN_EMBEDDING_MODEL.id,
      dimensions: BRAIN_EMBEDDING_MODEL.dimensions,
      prefixes: { query: 'q', document: 'd' },
      documents: Object.fromEntries([...claims.values()].map((c) => [c.summary, unit])),
      queries: Object.fromEntries(fixture.queries.map((q) => [q.text, unit])),
    }
    expect(() => checkReceipt(receipt, fixture, sha256)).not.toThrow()
    expect(() => checkReceipt({ ...receipt, fixtureSha256: 'other' }, fixture, sha256)).toThrow(
      'different fixture bytes',
    )
    expect(() => checkReceipt({ ...receipt, queries: {} }, fixture, sha256)).toThrow(
      'missing vector',
    )
  })
})
