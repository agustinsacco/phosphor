import type { BrainEntityKind, BrainMemoryType } from '@shared/brain'
import type { BrainEntitySort } from '@shared/brain-explore'

/** Plural group names for memory types, one spelling everywhere on the page. */
export const MEMORY_LABELS: Record<BrainMemoryType, string> = {
  decision: 'Decisions',
  open: 'Open',
  risk: 'Risks',
  procedure: 'How it is done',
  preference: 'Preferences',
  fact: 'Facts',
}
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

/** The index's sort select. */
export const ENTITY_SORT_LABELS: Record<BrainEntitySort, string> = {
  connected: 'Most connected',
  recent: 'Recently learned',
  name: 'A to Z',
}

/** Decisions and risks first, then standing facts and procedures. */
export const MEMORY_TYPE_ORDER = [
  'decision',
  'risk',
  'fact',
  'open',
  'procedure',
  'preference',
] as const
