import type { BrainExpansion, BrainRelationLine } from '@phosphor/shared/brain-recall'
import { named, sentence, type Parts, type Ref } from './format-render'
export function expandParts(r: BrainExpansion): Parts {
  const e = r.entity
  function relations(title: string, rows: BrainRelationLine[], ref: Ref) {
    return rows.length
      ? [
          title,
          ...rows.map(
            ({ link, other }) =>
              `- ${sentence(link, e ? [e, other] : [other])}${ref(link.memoryId)}`,
          ),
        ]
      : []
  }
  return {
    header: (ref) => [
      ...(e ? [`About: ${named(e)}.${e.description ? ' ' + e.description : ''}`] : []),
      ...relations('Now:', r.current, ref),
      ...relations('Before:', r.ended, ref),
      ...(r.together.length
        ? [
            `+${r.togetherMore + r.together.length} appear together, not explained yet: ${r.together.map((t) => `${t.entity.label} (${t.shared} memories)`).join(', ')}`,
          ]
        : []),
    ],
    entries: r.hits.map(({ memory }) => ({ memory, section: 'Memories:' })),
    footer: () => [
      ...(r.alternatives.length
        ? [
            `Also named ${e?.label}: ${r.alternatives.map((a) => `${a.label} (${a.kind}, ${a.description})`).join('; ')}. Add context to pick that one.`,
          ]
        : []),
      ...r.degradation.map((d) => `Search note: ${d}`),
      'Next: brain_search with from and to shows how two names connect.',
    ],
  }
}
