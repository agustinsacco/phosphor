import type {
  BrainTidyProblem,
  BrainTidySubjectDetail,
  BrainTidySuggestion,
  BrainTidySuggestionDetail,
} from '@shared/brain-tidy'
import { formatCount } from '@/lib/format'

/**
 * What a finished Tidy run found, without its subject: "found 2 things to tidy and folded 1
 * exact repeat". Null when it found and folded nothing.
 */
export function tidyFindings(suggestions: number, folded: number): string | null {
  const parts = [
    suggestions ? `found ${formatCount(suggestions, 'thing to tidy', 'things to tidy')}` : '',
    folded ? `folded ${formatCount(folded, 'exact repeat')}` : '',
  ]
  return parts.filter(Boolean).join(' and ') || null
}

/** The queue row and decision title: the two names, or the claim. */
export function tidyTitle(suggestion: BrainTidySuggestion): string {
  return suggestion.kind === 'same_entity'
    ? suggestion.subjects.map((subject) => subject.label).join(' · ')
    : (suggestion.subjects[0]?.label ?? 'Suggestion')
}

const FLAGGED_AS: Record<BrainTidyProblem, string> = {
  wrong: 'A lane says this is wrong',
  outdated: 'A lane says this is outdated',
  duplicate: 'A lane says this is a duplicate',
}
/** The queue row's second line. A flag's own title is unverified, so it is not repeated. */
export function tidyLine(suggestion: BrainTidySuggestion): string {
  return suggestion.flag ? FLAGGED_AS[suggestion.flag.problem] : suggestion.reason
}

/** Who found it, and what a model thinks: an opinion, never a decision. */
export function tidyOpinion(suggestion: BrainTidySuggestion, model: string): string {
  const verdict = suggestion.verdict
  if (!verdict)
    return suggestion.source === 'flag' ? 'Flagged by a lane.' : 'Found on this computer.'
  const by = `Checked by ${model || 'the reader model'}, which thinks`
  switch (verdict.kind) {
    case 'different':
      return `${by} these are different. Merge only if you know they are the same. ${verdict.reason}`
    case 'same':
      return `${by} these are the same. ${verdict.reason}`
    case 'conflict':
      return `${by} these disagree. ${verdict.reason}`
    case 'replaces': {
      const newer = suggestion.subjects.find((subject) => subject.id === verdict.newerId)
      return `${by} “${newer?.label ?? 'one side'}” is newer and replaces the other. ${verdict.reason}`
    }
  }
}

type EntityView = Extract<BrainTidySubjectDetail, { type: 'entity' }>['value']['entity']
/** For two records: A keeps the most memories, B is the other; null for anything else. */
export function tidyEntityPair(
  data: BrainTidySuggestionDetail,
): { a: EntityView; b: EntityView } | null {
  const [left, right] = data.subjects
  if (left?.type !== 'entity' || right?.type !== 'entity') return null
  return right.value.entity.memories > left.value.entity.memories
    ? { a: right.value.entity, b: left.value.entity }
    : { a: left.value.entity, b: right.value.entity }
}

/**
 * A name one record holds as another name and the other record also uses, so "Not the same"
 * can take it off. B first, as A is the one a merge would keep; a label is never removed.
 */
export function unnameTarget(pair: {
  a: EntityView
  b: EntityView
}): { entity: EntityView; name: string } | null {
  const names = (entity: EntityView): Set<string> =>
    new Set([entity.label, ...entity.aliases].map((name) => name.toLocaleLowerCase()))
  for (const [entity, other] of [
    [pair.b, pair.a],
    [pair.a, pair.b],
  ] as const) {
    const theirs = names(other)
    const name = entity.aliases.find((alias) => theirs.has(alias.toLocaleLowerCase()))
    if (name) return { entity, name }
  }
  return null
}
