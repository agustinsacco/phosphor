import type { BrainEntityKind, BrainMemoryType } from '@shared/brain'

/** The one-word type label in a memory row's fixed column. */
export const MEMORY_TYPE_WORDS: Record<BrainMemoryType, string> = {
  decision: 'Decision',
  open: 'Open',
  risk: 'Risk',
  procedure: 'How to',
  preference: 'Preference',
  fact: 'Fact',
}
/** Plural kind names for filters and legends. */
export const ENTITY_LABELS: Record<BrainEntityKind, string> = {
  person: 'People',
  team: 'Teams',
  organization: 'Organizations',
  project: 'Projects',
  component: 'Systems',
  document: 'Documents',
  concept: 'Concepts',
  event: 'Events',
}
/** Singular kind names for a tag beside one name. */
export const ENTITY_WORDS: Record<BrainEntityKind, string> = {
  person: 'person',
  team: 'team',
  organization: 'organization',
  project: 'project',
  component: 'system',
  document: 'document',
  concept: 'concept',
  event: 'event',
}
