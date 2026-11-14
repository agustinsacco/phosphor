import type { BrainStore, ProposalEntity, ProposalGroup } from '@phosphor/memory-engine/types'
import { fold, tokens } from '@phosphor/memory-engine/text'
import type { FoldedJob } from './fold'

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
