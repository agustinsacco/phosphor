import type {
  BrainStore,
  ProposalEntity,
  ProposalGroup,
  TranscriptSegment,
} from '@phosphor/memory-engine/types'
import type { StageAsk } from '../stage-types'
import { parseStageExtraction } from '../stage-parse'
import { parentsPrompt } from '../stage-prompts/parents'
import { segmentInputs } from '../stage-input'
import { makeWindow } from '../windows'
import { PARENT_CHARS } from '../constants'
import { mentions, fold, tokens } from '../text'
import { foldParts, type FoldedJob } from './fold'

export async function findParents(
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
      .filter((s) => batch.some((e) => [e.label, ...e.aliases].some((n) => mentions(s.text, n))))
      .sort((a, b) => coMentions(b.text, all) - coMentions(a.text, all))
    const selected: TranscriptSegment[] = []
    for (const segment of ranked) {
      if (makeWindow([...selected, segment]).text.length > PARENT_CHARS) continue
      selected.push(segment)
    }
    if (!selected.length) continue
    const window = makeWindow(selected)
    const requested = batch.map((e) => registry[all.findIndex((v) => v.ref === e.ref)])
    const extraction = await ask(
      'parents',
      i / 8 + 1,
      parentsPrompt(requested, registry, window.text),
      (a) => parseStageExtraction(a, window, registry),
      selected.map((s) => s.entryId),
      { registry, requested, segments: segmentInputs(selected, segments) },
    )
    const mapping = new Map(registry.map((e, index) => [e.ref, all[index]!.ref]))
    for (const e of extraction.entities) mapping.set(e.ref, `parents${i / 8 + 1}:${e.ref}`)
    const resolve = (ref: string): string => mapping.get(ref) ?? ref
    const part = {
      key: `parents${i / 8 + 1}`,
      window,
      truncated: false,
      extraction: {
        entities: extraction.entities.map((e) => ({ ...e, ref: resolve(e.ref) })),
        claims: extraction.claims.map((c) => ({
          ...c,
          ref: `parents${i / 8 + 1}:${c.ref}`,
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
}
function coMentions(text: string, entities: { label: string }[]): number {
  return entities.filter((e) => mentions(text, e.label)).length
}
export function prefixGroups(job: FoldedJob, entities: ProposalEntity[]): ProposalGroup[] {
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
  return [...groups.values()]
    .filter((members) => members.length >= 3)
    .map((members) => ({
      parent: {
        label: members[0]!.label.split(' ')[0]!,
        kind: 'project',
        entityId:
          entities.find((e) => fold(e.label) === fold(members[0]!.label.split(' ')[0]!))
            ?.entityId ?? null,
      },
      members: members.map((e) => e.ref),
    }))
}
