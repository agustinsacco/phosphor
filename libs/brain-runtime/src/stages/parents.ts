import type {
  BrainStore,
  ProposalEntity,
  ProposalGroup,
  TranscriptSegment,
} from '@phosphor/memory-engine/types'
import type { StageAsk, StageExtraction, StageEntity } from '../stage-types'
import { parseStageExtraction } from '../stage-parse'
import { parentsPrompt } from '../stage-prompts/parents'
import { segmentInputs } from '../stage-input'
import { makeWindow, inputHash, type TranscriptWindow } from '../windows'
import { PARENT_CHARS } from '../constants'
import { wholePhrase, fold, tokens } from '@phosphor/memory-engine/text'
import { foldParts, type FoldedJob } from './fold'

export async function findParents(
  jobId: string,
  job: FoldedJob,
  identities: ProposalEntity[],
  segments: TranscriptSegment[],
  store: BrainStore,
  ask: StageAsk,
): Promise<void> {
  const missing = job.entities.filter(
    (e) =>
      ['project', 'component', 'document', 'team'].includes(e.kind) &&
      !job.parents.some((p) => p.entity === e.ref && p.status === 'stated'),
  )
  const resolved = identities.flatMap((e) => (e.entityId ? [e.entityId] : []))
  const neighbours = store.neighbours(resolved, ['organization', 'project', 'team'], 60)
  for (let i = 0; i < missing.length; i += 8) {
    const batch = missing.slice(i, i + 8)
    const all = [
      ...job.entities,
      ...neighbours
        .filter(
          (n, index, rows) =>
            rows.findIndex((other) => other.neighbour.id === n.neighbour.id) === index,
        )
        .map((n) => ({ ...n.neighbour, ref: n.neighbour.id, keys: [] })),
    ]
    const registry = all.map((e, index) => ({ ...e, ref: `r${index + 1}` }))
    const ranked = segments
      .filter((s) => batch.some((e) => [e.label, ...e.aliases].some((n) => wholePhrase(s.text, n))))
      .sort((a, b) => coMentions(b.text, all) - coMentions(a.text, all))
    const selected: TranscriptSegment[] = []
    for (const segment of ranked) {
      const room = PARENT_CHARS - makeWindow([...selected, { ...segment, text: '' }]).text.length
      if (room <= 0) break
      selected.push({ ...segment, text: segment.text.slice(0, room) })
    }
    if (!selected.length) continue
    const window = makeWindow(selected)
    const requested = batch.map((e) => registry[all.findIndex((v) => v.ref === e.ref)]!)
    const extraction = await parentExtraction(
      jobId,
      i / 8 + 1,
      store,
      ask,
      requested,
      registry,
      window,
      segments,
    )
    appendParents(job, identities, window, extraction, registry, all, i / 8 + 1)
  }
}
async function parentExtraction(
  jobId: string,
  part: number,
  store: BrainStore,
  ask: StageAsk,
  requested: StageEntity[],
  registry: StageEntity[],
  window: TranscriptWindow,
  source: TranscriptSegment[],
): Promise<StageExtraction> {
  const prompt = parentsPrompt(requested, registry, window.text),
    hash = inputHash(prompt),
    key = `parents:${part}`
  const saved = store.part(jobId, key, hash)
  if (saved) return JSON.parse(saved.output) as StageExtraction
  const extraction = await ask(
    'parents',
    part,
    prompt,
    (answer) => {
      const result = parseStageExtraction(answer, window, registry)
      for (const e of requested)
        if (!result.parents.some((p) => p.entity === e.ref))
          throw new Error(`Missing parent assessment for ${e.ref}`)
      return result
    },
    window.segments.map((s) => s.entryId),
    { registry, requested, segments: segmentInputs(window.segments, source) },
  )
  store.savePart(jobId, { part: key, inputHash: hash, output: JSON.stringify(extraction) })
  return extraction
}
function appendParents(
  job: FoldedJob,
  identities: ProposalEntity[],
  window: TranscriptWindow,
  extraction: StageExtraction,
  registry: StageEntity[],
  all: StageEntity[],
  partNumber: number,
): void {
  const mapping = new Map(registry.map((e, index) => [e.ref, all[index]!.ref]))
  for (const e of extraction.entities) mapping.set(e.ref, `parents${partNumber}:${e.ref}`)
  const resolve = (ref: string): string => mapping.get(ref) ?? ref
  const part = {
    key: `parents${partNumber}`,
    window,
    truncated: false,
    extraction: {
      entities: extraction.entities.map((e) => ({ ...e, ref: resolve(e.ref) })),
      claims: extraction.claims.map((c) => ({
        ...c,
        ref: `parents${partNumber}:${c.ref}`,
        mentions: c.mentions.map(resolve),
        links: c.links.map((l) => ({
          ...l,
          subject: resolve(l.subject),
          object: resolve(l.object),
        })),
      })),
      parents: extraction.parents.map((p) => ({ ...p, entity: resolve(p.entity) })),
    },
  }
  const extra = foldParts([part], job.evidence[0]?.sessionId ?? '')
  const offset = job.evidence.length
  job.evidence.push(...extra.evidence)
  job.claims.push(
    ...extra.claims.map((c) => ({
      ...c,
      memory: {
        ...c.memory,
        citations: c.memory.citations.map((q) => ({ ...q, evidence: q.evidence + offset })),
        links: c.memory.links.map((l) => ({
          ...l,
          citation: { ...l.citation, evidence: l.citation.evidence + offset },
        })),
      },
    })),
  )
  job.parents.push(...extra.parents)
  job.entities.push(...extra.entities)
  identities.push(
    ...extra.entities.map((e) => ({
      ...e,
      decision: 'new' as const,
      entityId: null,
      candidates: [],
      reason: 'Supported parent discovered',
      auto: true,
    })),
  )
}

function coMentions(text: string, entities: { label: string }[]): number {
  return entities.filter((e) => wholePhrase(text, e.label)).length
}
export function prefixGroups(
  job: FoldedJob,
  entities: ProposalEntity[],
  store: BrainStore,
): ProposalGroup[] {
  const groups = new Map<string, ProposalEntity[]>()
  for (const e of entities) {
    if (
      job.parents.some((p) => p.entity === e.ref && p.status === 'stated') ||
      tokens(e.label).length < 2
    )
      continue
    const prefix = fold(e.label).split(' ')[0]!
    const list = groups.get(prefix) ?? []
    list.push(e)
    groups.set(prefix, list)
  }
  const siblings = [...groups.values()].filter((members) => members.length >= 3)
  const labels = siblings.map((members) => members[0]!.label.split(' ')[0]!)
  const matches = store.entityMatches(
    labels.map((label) => ({ label, aliases: [], keys: [] })),
    12,
  )
  const cards = store.entityCards([
    ...new Set(
      matches.flatMap((rows) => rows.filter((m) => m.channel === 'name').map((m) => m.entityId)),
    ),
  ])
  return siblings.map((members, index) => {
    const label = labels[index]!
    const exact = (e: { label: string; aliases: string[]; kind: string }): boolean =>
      ['organization', 'project', 'team'].includes(e.kind) &&
      [e.label, ...e.aliases].some((name) => fold(name) === fold(label))
    const jobParent = entities.find(exact)
    const candidates = cards.filter(
      (e) => exact(e) && matches[index]!.some((m) => m.channel === 'name' && m.entityId === e.id),
    )
    return {
      parent: {
        label,
        kind: 'project',
        entityId: jobParent?.ref ?? (candidates.length === 1 ? candidates[0]!.id : null),
      },
      members: members.map((e) => e.ref),
    }
  })
}
