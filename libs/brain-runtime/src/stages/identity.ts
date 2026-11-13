import type { BrainStore, EntityCard, ProposalEntity } from '@phosphor/memory-engine/types'
import type { BrainSearchPort } from '../types'
import type { StageAsk, StageEntity, IdentityResult } from '../stage-types'
import type { FoldedJob } from './fold'
import { mergeEntity, redirect, rewriteClaim } from './fold'
import { array, jsonAnswer, object, text } from '../stage-parse'
import { identityPrompt } from '../stage-prompts/identity'
import { fold, tokens } from '../text'

interface Candidate {
  id: string
  card: EntityCard
  score: number
  key: boolean
  exact: boolean
  local: boolean
}
interface Row {
  entity: StageEntity
  candidates: Candidate[]
}
function exact(a: StageEntity, b: EntityCard): boolean {
  return [a.label, ...a.aliases].some((name) =>
    [b.label, ...b.aliases].some((n) => fold(name) === fold(n)),
  )
}
function localCard(entity: StageEntity): EntityCard {
  return { ...entity, id: entity.ref, neighbours: [], memories: 0 }
}
function overlap(a: StageEntity, b: StageEntity): number {
  const words = new Set(tokens(`${a.label} ${a.description}`))
  return tokens(`${b.label} ${b.description}`).filter((w) => words.has(w)).length
}
async function candidates(
  job: FoldedJob,
  store: BrainStore,
  search: BrainSearchPort,
  vectors: Float32Array[],
  pool: StageEntity[],
  anchors: ProposalEntity[],
): Promise<Row[]> {
  const matches = store.entityMatches(job.entities, 20)
  const semantic = await search.nearestEntities(vectors, 20)
  const cards = new Map(
    store
      .entityCards([
        ...new Set([
          ...anchors.flatMap((e) => (e.entityId ? [e.entityId] : [])),
          ...matches.flatMap((m) => m.map((v) => v.entityId)),
          ...semantic.flatMap((m) => m.map((v) => v.id)),
        ]),
      ])
      .map((c) => [c.id, c]),
  )
  return job.entities.map((entity, index) => {
    const byId = new Map<string, Candidate>()
    for (const m of matches[index] ?? []) {
      const card = cards.get(m.entityId)
      if (!card) continue
      const old = byId.get(card.id)
      const key = m.channel === 'key' || old?.key === true
      byId.set(card.id, {
        id: card.id,
        card,
        score: Math.max(
          old?.score ?? 0,
          m.channel === 'key' ? 1000 : m.channel === 'name' ? 500 : m.score,
        ),
        key,
        exact: exact(entity, card),
        local: false,
      })
    }
    for (const m of semantic[index] ?? []) {
      const card = cards.get(m.id)
      if (card && !byId.has(m.id))
        byId.set(m.id, {
          id: m.id,
          card,
          score: m.score,
          key: false,
          exact: exact(entity, card),
          local: false,
        })
    }
    addJobCandidates(entity, pool, anchors, cards, byId)
    return {
      entity,
      candidates: [...byId.values()]
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 12),
    }
  })
}
function addJobCandidates(
  entity: StageEntity,
  pool: StageEntity[],
  anchors: ProposalEntity[],
  cards: Map<string, EntityCard>,
  byId: Map<string, Candidate>,
): void {
  for (const other of pool) {
    if (other.ref === entity.ref) continue
    const score = overlap(entity, other)
    const sharedKey = entity.keys.some((k) =>
      other.keys.some((o) => k.namespace === o.namespace && k.value === o.value),
    )
    if (!score && !sharedKey) continue
    const anchor = anchors.find((e) => e.ref === other.ref)?.entityId
    const id = anchor ?? other.ref,
      card = anchor ? (cards.get(anchor) ?? { ...localCard(other), id: anchor }) : localCard(other)
    const previous = byId.get(id)
    byId.set(id, {
      id,
      card,
      score: Math.max(previous?.score ?? 0, sharedKey ? 1000 : score),
      key: sharedKey || previous?.key === true,
      exact: exact(entity, card),
      local: !anchor,
    })
  }
}
function automatic(
  row: Row,
  job: FoldedJob,
  resolved: Map<string, string>,
  pool: StageEntity[],
): Candidate | undefined {
  const keys = row.candidates.filter((c) => c.key)
  if (keys.length === 1) return keys[0]
  const neighbourLabels = job.claims
    .flatMap((c) =>
      c.memory.links.flatMap((l) =>
        l.subject === row.entity.ref ? [l.object] : l.object === row.entity.ref ? [l.subject] : [],
      ),
    )
    .filter((id) => resolved.has(id))
    .flatMap((id) => pool.filter((e) => e.ref === id).map((e) => fold(e.label)))
  const names = row.candidates.filter(
    (c) => c.exact && neighbourLabels.some((n) => c.card.neighbours.some((v) => fold(v) === n)),
  )
  return names.length === 1 ? names[0] : undefined
}
function parseDecisions(answer: string, rows: Row[]) {
  const decisions = array(jsonAnswer(answer).decisions).map((v) => {
    const d = object(v),
      ref = text(d.ref),
      row = rows.find((r) => r.entity.ref === ref)
    if (!row || !['reuse', 'new', 'uncertain'].includes(String(d.action)))
      throw new Error('Invalid identity decision')
    const candidate =
      d.action === 'reuse'
        ? row.candidates.slice(0, 8).find((_c, i) => `K${i + 1}` === d.candidate)
        : undefined
    if ((d.action === 'reuse' && !candidate) || (d.action !== 'reuse' && d.candidate !== null))
      throw new Error(`Unoffered identity candidate for ${ref}`)
    return {
      ref,
      action: d.action as ProposalEntity['decision'],
      candidate,
      reason: text(d.reason),
    }
  })
  if (decisions.length !== rows.length || new Set(decisions.map((d) => d.ref)).size !== rows.length)
    throw new Error('Expected one identity decision per entity')
  return decisions
}
export async function resolveIdentities(
  job: FoldedJob,
  store: BrainStore,
  search: BrainSearchPort,
  vectors: Float32Array[],
  ask: StageAsk,
  pool: StageEntity[] = job.entities,
  anchors: ProposalEntity[] = [],
): Promise<IdentityResult> {
  const rows = await candidates(job, store, search, vectors, pool, anchors),
    entities: ProposalEntity[] = [],
    redirects = new Map<string, string>(),
    resolved = new Map<string, string>(
      anchors.flatMap((e) => (e.entityId ? [[e.ref, e.entityId]] : [])),
    ),
    ambiguous: Row[] = []
  const state = { job, entities, redirects, resolved }
  for (const row of rows) {
    const chosen = automatic(row, job, resolved, pool)
    if (chosen)
      addDecision(
        state,
        row,
        'reuse',
        chosen,
        'Unique key or exact name with resolved neighbour',
        true,
      )
    else if (!row.candidates.length)
      addDecision(state, row, 'new', undefined, 'No identity candidates', true)
    else ambiguous.push(row)
  }
  for (let i = 0; i < ambiguous.length; i += 8) {
    const batch = ambiguous.slice(i, i + 8)
    const rows = batch.map((r) => ({
      entity: r.entity,
      candidates: r.candidates.slice(0, 8).map((c, j) => ({ handle: `K${j + 1}`, ...c.card })),
    }))
    const decisions = await ask(
      'identity',
      i / 8 + 1,
      identityPrompt(rows),
      (a) => parseDecisions(a, batch),
      [],
      { rows },
    )
    for (const d of decisions)
      addDecision(
        state,
        batch.find((r) => r.entity.ref === d.ref)!,
        d.action,
        d.candidate,
        d.reason,
        false,
      )
  }
  for (const [source] of redirects) {
    const target =
        entities.find((e) => e.ref === redirect(source, redirects)) ??
        pool.find((e) => e.ref === redirect(source, redirects)),
      from = entities.find((e) => e.ref === source)
    if (target && from) mergeEntity(target, from)
  }
  job.claims = job.claims.map((c) => rewriteClaim(c, redirects, job.outcomes))
  job.parents = job.parents.map((p) => ({ ...p, entity: redirect(p.entity, redirects) }))
  job.entities = entities.filter((e) => !redirects.has(e.ref))
  return { entities: entities.filter((e) => !redirects.has(e.ref)), redirects }
}

function addDecision(
  {
    job,
    entities,
    redirects,
    resolved,
  }: {
    job: FoldedJob
    entities: ProposalEntity[]
    redirects: Map<string, string>
    resolved: Map<string, string>
  },
  row: Row,
  decision: ProposalEntity['decision'],
  candidate: Candidate | undefined,
  reason: string,
  auto: boolean,
): void {
  if (candidate?.local) {
    const target = redirect(candidate.id, redirects)
    if (target !== row.entity.ref) {
      redirects.set(row.entity.ref, target)
      job.outcomes.push({
        candidate: row.entity.ref,
        summary: row.entity.label,
        status: 'folded',
        reason: `Identity reuse of job entity ${target}: ${reason}`,
      })
    }
  }
  if (candidate && !candidate.local) resolved.set(row.entity.ref, candidate.id)
  entities.push({
    ...row.entity,
    decision: candidate?.local ? 'new' : decision,
    entityId: candidate && !candidate.local ? candidate.id : null,
    candidates: row.candidates
      .filter((c) => !c.local)
      .slice(0, 8)
      .map((c) => c.id),
    reason,
    auto,
  })
}
