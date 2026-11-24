import { BRAIN_PREDICATE_LABELS, brainLinkWords } from '@phosphor/shared/brain-links'
import type { BrainRecall, BrainHit, BrainTrail } from '@phosphor/shared/brain-recall'
import { named, sentence, type Parts } from './format-render'
const titles = {
  disputed: 'Disputed, both sides shown:',
  risk: 'Risks:',
  open: 'Open, may have changed since:',
  decision: 'Decisions:',
  fact: 'Facts:',
  procedure: 'How things are done:',
  preference: 'Preferences:',
  planned: 'Planned, not in effect yet:',
  other_branch: 'Other branches only:',
}
export function searchParts(r: BrainRecall, now: number): Parts {
  const names = new Map(r.entities.map((e) => [e.id, e]))
  const focus = r.focus.flatMap((id) => names.get(id) ?? []).slice(0, 6)
  const nearby = [...new Set(r.hits.flatMap((h) => h.memory.entityIds))]
    .filter((id) => !r.focus.includes(id))
    .flatMap((id) => names.get(id)?.label ?? [])
    .slice(0, 6)
  function key({ memory: m }: BrainHit) {
    return m.state === 'disputed'
      ? 'disputed'
      : m.validFrom !== null && m.validFrom > now
        ? 'planned'
        : m.branch && m.branch !== r.branch
          ? 'other_branch'
          : m.type
  }
  function via(trail: BrainTrail) {
    const label = (id: string) => names.get(id)?.label ?? 'unknown'
    let id = trail.seedId
    const steps = [label(id)]
    for (const link of trail.links) {
      const forward = id === link.subjectId
      id = forward ? link.objectId : link.subjectId
      // A custom sentence has no inferred inverse. Keep its stated direction.
      steps.push(
        !forward && link.label
          ? sentence(link, r.entities)
          : `${forward ? brainLinkWords(link) : BRAIN_PREDICATE_LABELS[link.predicate].in.toLowerCase()} ${label(id)}`,
      )
    }
    return `via ${steps.join(', ')}`
  }
  const entries = Object.entries(titles).flatMap(([k, section]) =>
    r.hits
      .filter((h) => key(h) === k)
      .map(({ memory, trail }) => ({
        memory,
        section,
        trail: trail ? via(trail) : '',
      })),
  )
  return {
    entries,
    header: () => (focus.length ? [`About: ${focus.map(named).join('; ')}`] : []),
    footer(omitted) {
      const more = r.more + omitted
      return [
        ...(more
          ? [
              `${r.more >= 50 ? '50+' : more} more ${more === 1 ? 'match' : 'matches'} not shown. Search again with a higher limit (up to 20) or a narrower query.`,
            ]
          : []),
        ...(nearby.length
          ? [`See also: ${nearby.join(', ')}. Search a name to see what Brain holds about it.`]
          : []),
        ...r.degradation.map((d) => `Search note: ${d}`),
      ]
    },
  }
}
