import type { SQLInputValue } from 'node:sqlite'
import type {
  BrainClaim,
  BrainEntity,
  BrainGraph,
  BrainQuery,
  BrainSearchHit,
  BrainSearchResult,
} from '@phosphor/shared/brain'
import { type Data } from './data'
import { type Evidence } from './evidence'
import * as validate from './validation'
import { knownEntities } from './entities'

type Ranked = { claim: BrainClaim; reasons: BrainSearchHit['reasons']; score: number }
type BranchQuery = BrainQuery & { branch?: string | null }
const fold = (text: string) => text.normalize('NFKC').toLowerCase()
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1
  // Scaling avoids overflow for untrusted finite vector magnitudes.
  const scaleA = Math.max(...a.map(Math.abs)),
    scaleB = Math.max(...b.map(Math.abs))
  let dot = 0,
    aa = 0,
    bb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! / scaleA,
      y = b[i]! / scaleB
    dot += x * y
    aa += x * x
    bb += y * y
  }
  return dot / Math.sqrt(aa * bb)
}
function finish(result: BrainSearchResult, ambiguous: boolean): BrainSearchResult {
  if (result.truncated)
    result.degradation.push('Bounded retrieval or evidence budget truncated results')
  if (ambiguous)
    result.degradation.push('Alias identifies multiple entities; select an entity to disambiguate')
  result.status = result.results.length
    ? ambiguous
      ? 'needs_disambiguation'
      : result.degradation.length
        ? 'partial'
        : 'ok'
    : result.degradation.length
      ? 'partial'
      : 'no_match'
  return result
}
export class Retrieval {
  constructor(
    readonly data: Data,
    readonly evidence: Evidence,
  ) {}
  private eligible(scopes: string[], query: BranchQuery): { sql: string; params: SQLInputValue[] } {
    const known = query.knownAt ?? this.data.now(),
      valid = query.validAt ?? this.data.now()
    return {
      sql: `d.kind='claims' AND d.scope IN (${scopes.map(() => '?').join(',')})
        AND v.seq=(SELECT seq FROM claim_versions WHERE claim_id=d.id AND recorded_at<=?
          ORDER BY recorded_at DESC,seq DESC LIMIT 1)
        AND json_extract(v.value,'$.recordedAt')<=?
        AND (json_extract(v.value,'$.retractedAt') IS NULL OR json_extract(v.value,'$.retractedAt')>?)
        AND (json_extract(v.value,'$.validFrom') IS NULL OR json_extract(v.value,'$.validFrom')<=?)
        AND (json_extract(v.value,'$.validTo') IS NULL OR json_extract(v.value,'$.validTo')>?)
        AND EXISTS (SELECT 1 FROM claim_sources WHERE claim_id=d.id)
        AND NOT EXISTS (SELECT 1 FROM claim_sources cs LEFT JOIN documents e
          ON e.kind='evidence' AND e.id=cs.evidence_id WHERE cs.claim_id=d.id AND
          (e.id IS NULL OR json_type(e.value,'$.branch') IS NULL OR json_type(e.value,'$.branch') NOT IN ('null','text')
            OR (json_extract(e.value,'$.branch') IS NOT NULL AND
              (? IS NULL OR json_extract(e.value,'$.branch')!=?))))`,
      params: [
        ...scopes,
        known,
        known,
        known,
        valid,
        valid,
        query.branch ?? null,
        query.branch ?? null,
      ],
    }
  }
  search(
    query: BranchQuery,
    allowedScopes: string[],
    vector?: { modelId: string; values: number[] },
  ): BrainSearchResult {
    validate.query(query)
    validate.strings(allowedScopes, 100)
    if (vector) {
      validate.text(vector.modelId, 500)
      validate.vector(vector.values)
    }
    const result: BrainSearchResult = {
      ...this.data.revision(),
      status: 'no_match',
      results: [],
      entities: [],
      degradation: [],
      truncated: false,
    }
    if (!this.data.prefs().enabled)
      return { ...result, status: 'unavailable', degradation: ['Memory is disabled'] }
    const scopes = [...new Set(allowedScopes)].filter(
      (scope) => this.data.enrolled(scope) && (!query.scopes || query.scopes.includes(scope)),
    )
    if (!scopes.length) return result
    const eligible = this.eligible(scopes, query)
    const rows = this.data.db
      .prepare(
        `SELECT v.value FROM documents d JOIN claim_versions v ON v.claim_id=d.id WHERE ${eligible.sql} ORDER BY d.id LIMIT 5001`,
      )
      .all(...eligible.params)
    result.truncated = rows.length > 5000
    const claims = rows.slice(0, 5000).map((row) => JSON.parse(String(row.value)) as BrainClaim)
    const known = knownEntities(
      this.data,
      scopes,
      query.knownAt ?? this.data.now(),
      2001,
      query.branch ?? null,
    )
    const entities = known.entities
    if (known.truncated) result.truncated = true
    if (entities.length > 2000) {
      result.truncated = true
      entities.pop()
    }
    const ranked = new Map<string, Ranked>()
    const exact = entities.filter(
      (entity) =>
        query.entityIds?.includes(entity.id) ||
        [entity.label, ...entity.aliases].some((alias) => fold(alias) === fold(query.query.trim())),
    )
    const exactIds = new Set(exact.map((entity) => entity.id))
    this.rank(
      claims.filter(
        (claim) =>
          exactIds.has(claim.subjectId) ||
          (claim.objectId !== null && exactIds.has(claim.objectId)),
      ),
      ranked,
      'exact',
    )
    this.lexical(query, eligible, claims, ranked)
    this.semantic(query, vector, claims, ranked, result)
    this.expand(claims, ranked, exactIds)
    this.pack([...ranked.values()], entities, query, result)
    return finish(result, exact.length > 1 && !query.entityIds?.length)
  }
  private rank(
    claims: BrainClaim[],
    ranked: Map<string, Ranked>,
    reason: BrainSearchHit['reasons'][number],
  ): void {
    claims.forEach((claim, index) => {
      const item = ranked.get(claim.id) ?? { claim, reasons: [], score: 0 }
      if (!item.reasons.includes(reason)) {
        item.reasons.push(reason)
        item.score += 1 / (60 + index + 1)
      }
      ranked.set(claim.id, item)
    })
  }
  private lexical(
    query: BrainQuery,
    eligible: { sql: string; params: SQLInputValue[] },
    claims: BrainClaim[],
    ranked: Map<string, Ranked>,
  ): void {
    const tokens = query.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24) ?? []
    if (!tokens.length) return
    const syntax = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ')
    const rows = this.data.db
      .prepare(
        `SELECT d.id FROM claim_fts JOIN documents d ON d.id=claim_fts.id
      JOIN claim_versions v ON v.claim_id=d.id WHERE claim_fts MATCH ? AND ${eligible.sql} ORDER BY d.id LIMIT 5001`,
      )
      .all(syntax, ...eligible.params)
    const matches = new Set(rows.map((row) => String(row.id)))
    const terms = new Set(tokens.map(fold))
    // Global FTS BM25 statistics include private scopes and future documents. Rank only the eligible set.
    const scored = claims
      .filter((claim) => matches.has(claim.id))
      .map((claim) => {
        const words = fold(claim.summary).match(/[\p{L}\p{N}_]+/gu) ?? []
        return {
          claim,
          score: words.filter((word) => terms.has(word)).length / Math.sqrt(words.length || 1),
        }
      })
    this.rank(
      scored
        .sort((a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id))
        .slice(0, 200)
        .map((item) => item.claim),
      ranked,
      'lexical',
    )
  }
  private semantic(
    query: BrainQuery,
    vector: { modelId: string; values: number[] } | undefined,
    claims: BrainClaim[],
    ranked: Map<string, Ranked>,
    result: BrainSearchResult,
  ): void {
    if (query.mode === 'lexical') return
    if (!vector) {
      result.degradation.push(
        'Local query embedding unavailable; lexical and relationship retrieval only',
      )
      return
    }
    const scores: { claim: BrainClaim; score: number }[] = []
    let missing = 0
    const statement = this.data.db.prepare(
      'SELECT value FROM vectors WHERE claim_id=? AND model_id=? AND revision=?',
    )
    for (const claim of claims) {
      const row = statement.get(claim.id, vector.modelId, claim.revision)
      if (!row) {
        missing++
        continue
      }
      const stored = JSON.parse(String(row.value)) as number[]
      if (stored.length !== vector.values.length) {
        missing++
        continue
      }
      const score = cosine(stored, vector.values)
      if (score > 0) scores.push({ claim, score })
    }
    if (missing) result.degradation.push('Some claims lack compatible local vectors')
    this.rank(
      scores
        .sort((a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id))
        .slice(0, 200)
        .map((item) => item.claim),
      ranked,
      'semantic',
    )
  }
  private expand(claims: BrainClaim[], ranked: Map<string, Ranked>, exact: Set<string>): void {
    let frontier = new Set(exact)
    for (const item of exact.size
      ? []
      : [...ranked.values()].sort((a, b) => b.score - a.score).slice(0, 20)) {
      frontier.add(item.claim.subjectId)
      if (item.claim.objectId) frontier.add(item.claim.objectId)
    }
    const visited = new Set<string>()
    for (let hop = 0; hop < 2; hop++) {
      const next = new Set<string>()
      const adjacent = claims
        .filter(
          (claim) =>
            claim.objectId && (frontier.has(claim.subjectId) || frontier.has(claim.objectId)),
        )
        .slice(0, 200)
      for (const claim of adjacent) {
        if (!ranked.has(claim.id))
          ranked.set(claim.id, { claim, score: 1 / (300 + hop), reasons: ['relationship'] })
        next.add(claim.subjectId)
        if (claim.objectId) next.add(claim.objectId)
      }
      for (const id of frontier) visited.add(id)
      frontier = new Set([...next].filter((id) => !visited.has(id)))
    }
  }
  private pack(
    ranked: Ranked[],
    entities: BrainEntity[],
    query: BrainQuery,
    result: BrainSearchResult,
  ): void {
    // UTF-8 bytes conservatively bound tokens; reserve space for result metadata, not just source text.
    let remaining = Math.max(0, (query.tokenBudget ?? 4000) - 512)
    const entityIds = new Set<string>()
    const limit = query.limit ?? 10
    for (const item of ranked.sort(
      (a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id),
    )) {
      if (result.results.length >= limit) {
        result.truncated = true
        break
      }
      if (item.claim.citations.length > 4) {
        result.truncated = true
        continue
      }
      try {
        const evidence = [
          ...new Set(item.claim.citations.map((citation) => citation.evidenceId)),
        ].map((id) => this.evidence.read(id, [item.claim.scope]))
        const cost = Buffer.byteLength(JSON.stringify({ ...item, evidence }))
        if (cost > remaining) {
          result.truncated = true
          continue
        }
        remaining -= cost
        result.results.push({ ...item, evidence })
        entityIds.add(item.claim.subjectId)
        if (item.claim.objectId) entityIds.add(item.claim.objectId)
      } catch {
        result.degradation.push('Retained evidence unavailable or integrity check failed')
      }
    }
    for (const entity of entities.filter((entity) => entityIds.has(entity.id))) {
      const cost = Buffer.byteLength(JSON.stringify(entity))
      if (cost <= remaining) {
        result.entities.push(entity)
        remaining -= cost
      } else result.truncated = true
    }
  }
  graph(entityId?: string): BrainGraph {
    if (entityId !== undefined) validate.text(entityId)
    const scopes = this.data.prefs().workspaces.filter((scope) => this.data.enrolled(scope))
    if (!scopes.length) return { nodes: [], edges: [], truncated: false }
    const eligible = this.eligible(scopes, { query: '' })
    const rows = this.data.db
      .prepare(
        `SELECT v.value FROM documents d JOIN claim_versions v ON v.claim_id=d.id WHERE ${eligible.sql} ORDER BY d.id LIMIT 2001`,
      )
      .all(...eligible.params)
    const all = rows.slice(0, 2000).map((row) => JSON.parse(String(row.value)) as BrainClaim)
    let edges = all
    if (entityId) {
      let frontier = new Set([entityId])
      const found = new Map<string, BrainClaim>()
      for (let hop = 0; hop < 2; hop++) {
        const next = new Set<string>()
        for (const claim of all)
          if (frontier.has(claim.subjectId) || (claim.objectId && frontier.has(claim.objectId))) {
            found.set(claim.id, claim)
            next.add(claim.subjectId)
            if (claim.objectId) next.add(claim.objectId)
          }
        frontier = next
      }
      edges = [...found.values()]
    }
    const ids = new Set(
      edges
        .slice(0, 500)
        .flatMap((claim) => [claim.subjectId, ...(claim.objectId ? [claim.objectId] : [])]),
    )
    const known = knownEntities(this.data, scopes, this.data.now(), 200, null, [...ids])
    const nodes = known.entities
    const nodeIds = new Set(nodes.map((node) => node.id))
    const packed = edges
      .slice(0, 500)
      .filter(
        (claim) => nodeIds.has(claim.subjectId) && (!claim.objectId || nodeIds.has(claim.objectId)),
      )
    return {
      nodes,
      edges: packed,
      truncated:
        known.truncated ||
        rows.length > 2000 ||
        edges.length > packed.length ||
        ids.size > nodes.length,
    }
  }
}
