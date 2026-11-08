// Ranks the synthetic queries with three systems and scores them against the
// fixture's frozen labels:
//   A        engine search, mode 'lexical': exact alias + lexical + typed-graph expansion.
//   B        engine search, mode 'hybrid' with a local query vector: adds semantic RRF.
//   baseline raw-transcript FTS5/BM25 over captured evidence text only (no claims,
//            entities, aliases, graph or validity), filtered by the same metadata any
//            transcript search has: allowed scope, branch (null or the query's own) and
//            observedAt <= knownAt.
// Claim-level labels apply to A and B. Evidence-level labels (the evidence the
// gold or forbidden claims cite) apply to all three.
import type { DatabaseSync } from 'node:sqlite'
import type { BrainSearchResult } from '@phosphor/shared/brain'
import {
  allClaims,
  type EvalFixture,
  type EvalQuery,
  type EvalStore,
  type EvalViolation,
} from './retrieval-eval-store'

export const EVAL_LIMIT = 10
export interface Ranked {
  /** Fixture keys, best first. Claims are empty for the baseline. */
  claims: string[]
  evidence: string[]
  contested: string[]
  status: BrainSearchResult['status'] | 'baseline'
  degradation: string[]
  ms: number
}
export interface Labels {
  gold: string[]
  forbid: { item: string; why: EvalViolation }[]
}
export interface QueryScore {
  id: string
  category: EvalQuery['category']
  gold: number
  top1: boolean | null
  recall5: number | null
  recall10: number | null
  firstGold: number | null
  returned: number
  /** Forbidden items anywhere in the returned list, with their 1-based rank. */
  violations: { item: string; why: EvalViolation; rank: number }[]
  ms: number
}

/** The engine's lexical tokenization (retrieval.ts), so both lexical systems see the same terms. */
export function queryTokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24) ?? []
}

const unique = (items: string[]) => [...new Set(items)]

export function engineRun(
  built: EvalStore,
  fixture: EvalFixture,
  query: EvalQuery,
  mode: 'lexical' | 'hybrid',
  vector?: { modelId: string; values: number[] },
): Ranked {
  const started = performance.now()
  const result = built.store.search(
    {
      query: query.text,
      branch: query.branch ?? null,
      mode,
      limit: EVAL_LIMIT,
      ...(query.validAt === undefined ? {} : { validAt: query.validAt }),
      ...(query.knownAt === undefined ? {} : { knownAt: query.knownAt }),
    },
    fixture.allowedScopes,
    vector,
  )
  const ms = performance.now() - started
  const key = (id: string) => built.claimKey.get(id) ?? `unknown:${id}`
  return {
    claims: result.results.map((hit) => key(hit.claim.id)),
    evidence: unique(
      result.results.flatMap((hit) =>
        hit.claim.citations.map((c) => built.evidenceKey.get(c.evidenceId) ?? c.evidenceId),
      ),
    ),
    contested: result.results
      .filter((hit) => hit.claim.state === 'contested')
      .map((hit) => key(hit.claim.id)),
    status: result.status,
    degradation: result.degradation,
    ms,
  }
}

export function createBaseline(fixture: EvalFixture, Database: typeof DatabaseSync) {
  const db = new Database(':memory:')
  db.exec(
    'CREATE VIRTUAL TABLE raw USING fts5(key UNINDEXED, scope UNINDEXED, branch UNINDEXED, observed UNINDEXED, text)',
  )
  const insert = db.prepare('INSERT INTO raw VALUES (?,?,?,?,?)')
  for (const item of fixture.evidence) {
    const observed = item.phase === 1 ? fixture.clock.phase1 : fixture.clock.phase2
    insert.run(item.key, item.scope, item.branch ?? '', observed, item.text)
  }
  const scopes = fixture.allowedScopes.map(() => '?').join(',')
  const statement = db.prepare(
    `SELECT key FROM raw WHERE raw MATCH ? AND scope IN (${scopes}) AND (branch='' OR branch=?)
      AND observed<=? ORDER BY bm25(raw), key LIMIT ?`,
  )
  return {
    search(query: EvalQuery): Ranked {
      const started = performance.now()
      const words = queryTokens(query.text)
      const rows = words.length
        ? statement.all(
            words.map((word) => `"${word.replaceAll('"', '""')}"`).join(' OR '),
            ...fixture.allowedScopes,
            query.branch ?? '',
            query.knownAt ?? fixture.clock.query,
            EVAL_LIMIT,
          )
        : []
      const ms = performance.now() - started
      const evidence = rows.map((row) => String(row.key))
      return { claims: [], evidence, contested: [], status: 'baseline', degradation: [], ms }
    },
    close: () => db.close(),
  }
}

export function claimLabels(query: EvalQuery): Labels {
  return {
    gold: query.gold,
    forbid: query.forbid.map(({ claim, why }) => ({ item: claim, why })),
  }
}

/** The evidence gold claims cite; forbidden evidence is cited only by forbidden claims. */
export function evidenceLabels(fixture: EvalFixture, query: EvalQuery): Labels {
  const claims = new Map(allClaims(fixture).map((claim) => [claim.key, claim]))
  const cited = (key: string) => claims.get(key)!.citations.map((c) => c.evidence)
  const gold = unique(query.gold.flatMap(cited))
  const forbid = query.forbid.flatMap(({ claim, why }) =>
    unique(cited(claim))
      .filter((item) => !gold.includes(item))
      .map((item) => ({ item, why })),
  )
  return { gold, forbid }
}

export function scoreQuery(query: EvalQuery, ranked: string[], labels: Labels, ms: number) {
  const recall = (k: number) =>
    labels.gold.length
      ? labels.gold.filter((item) => ranked.slice(0, k).includes(item)).length / labels.gold.length
      : null
  const first = ranked.findIndex((item) => labels.gold.includes(item))
  const score: QueryScore = {
    id: query.id,
    category: query.category,
    gold: labels.gold.length,
    top1: labels.gold.length ? labels.gold.includes(ranked[0] ?? '') : null,
    recall5: recall(5),
    recall10: recall(10),
    firstGold: first < 0 ? null : first + 1,
    returned: ranked.length,
    violations: labels.forbid
      .filter(({ item }) => ranked.includes(item))
      .map(({ item, why }) => ({ item, why, rank: ranked.indexOf(item) + 1 })),
    ms,
  }
  return score
}
