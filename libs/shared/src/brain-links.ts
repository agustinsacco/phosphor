/**
 * Links: directed relationships between two entities, each stated by one memory. The predicate
 * is the category recall ranks and filters by; the label is the wording people read.
 */
import type { BrainEntityKind } from './brain'

/** Directed relationship types, read subject → object. A memory can state several. */
export const BRAIN_PREDICATES = [
  'owns',
  'works_on',
  'member_of',
  'part_of',
  'for_customer',
  'documents',
  'depends_on',
  'uses',
  'decided',
  'prefers',
  'leads',
  'reports_to',
  'works_with',
  'took_over_from',
] as const
export type BrainPredicate = (typeof BRAIN_PREDICATES)[number]
/** Extraction-only endpoint rules; a merge may re-point an identity across kinds. */
export const BRAIN_LINK_RULES: Record<
  BrainPredicate,
  { subject: readonly BrainEntityKind[]; object: readonly BrainEntityKind[] }
> = {
  owns: {
    subject: ['person', 'team', 'organization'],
    object: ['project', 'component', 'document'],
  },
  works_on: {
    subject: ['person', 'team'],
    object: ['project', 'component', 'document', 'organization'],
  },
  member_of: { subject: ['person', 'team'], object: ['team', 'organization'] },
  part_of: {
    subject: ['component', 'project', 'document', 'team'],
    object: ['component', 'project', 'team', 'organization'],
  },
  for_customer: { subject: ['project', 'component', 'document', 'team'], object: ['organization'] },
  documents: {
    subject: ['document'],
    object: ['project', 'component', 'concept', 'team', 'organization', 'event'],
  },
  depends_on: {
    subject: ['component', 'project'],
    object: ['component', 'project', 'organization'],
  },
  uses: {
    subject: ['component', 'project', 'team', 'person', 'organization'],
    object: ['component', 'project', 'organization', 'concept', 'document'],
  },
  decided: {
    subject: ['person', 'team', 'organization'],
    object: ['project', 'component', 'document', 'concept', 'event', 'organization'],
  },
  prefers: {
    subject: ['person', 'team', 'organization'],
    object: ['component', 'project', 'concept', 'document', 'organization'],
  },
  leads: { subject: ['person'], object: ['team', 'project'] },
  reports_to: { subject: ['person'], object: ['person'] },
  works_with: { subject: ['person', 'team'], object: ['person', 'team'] },
  took_over_from: { subject: ['person', 'team'], object: ['person', 'team'] },
}
/** Predicates that place an entity: recall weighs them above the rest. */
export const BRAIN_STRUCTURAL_PREDICATES = [
  'part_of',
  'for_customer',
  'owns',
  'member_of',
  'documents',
  'leads',
  'reports_to',
] as const satisfies readonly BrainPredicate[]
/** A subject holds at most one current link of each: a new object contradicts the old one. */
export const BRAIN_SINGLE_VALUED_PREDICATES = [
  'reports_to',
] as const satisfies readonly BrainPredicate[]
/** Stored once, with the lower entity number as subject. */
export const BRAIN_SYMMETRIC_PREDICATES = [
  'works_with',
] as const satisfies readonly BrainPredicate[]
/** Plain words for each predicate, from the subject's side and from the object's side. */
export const BRAIN_PREDICATE_LABELS: Record<BrainPredicate, { out: string; in: string }> = {
  leads: { out: 'Leads', in: 'Led by' },
  owns: { out: 'Owns', in: 'Owned by' },
  works_on: { out: 'Works on', in: 'Worked on by' },
  member_of: { out: 'Member of', in: 'Members' },
  part_of: { out: 'Part of', in: 'Contains' },
  for_customer: { out: 'For customer', in: 'Customer of' },
  documents: { out: 'Documents', in: 'Documented in' },
  depends_on: { out: 'Depends on', in: 'Needed by' },
  uses: { out: 'Uses', in: 'Used by' },
  decided: { out: 'Decided', in: 'Decided by' },
  prefers: { out: 'Prefers', in: 'Preferred by' },
  reports_to: { out: 'Reports to', in: 'Manages' },
  works_with: { out: 'Works with', in: 'Works with' },
  took_over_from: { out: 'Took over from', in: 'Handed over to' },
}
/** The longest label a link keeps, in characters. */
export const BRAIN_LINK_LABEL_MAX = 80

/** Who stated a link: the reader of a lane, Brain Agent, or you. */
export type BrainStatedBy = 'reader' | 'agent' | 'owner'
/** One directed relationship, stated and supported by one memory. */
export interface BrainLink {
  id: string
  subjectId: string
  predicate: BrainPredicate
  objectId: string
  memoryId: string
  /** The wording, read subject to object. Empty falls back to the predicate's words. */
  label: string
  /** When the relationship started and ended, when known. A past end means it is history. */
  validFrom: number | null
  validTo: number | null
  statedBy: BrainStatedBy
}

/** The link's wording, read subject to object: its label, else the predicate's words. */
export function brainLinkWords(link: Pick<BrainLink, 'label' | 'predicate'>): string {
  const label = link.label.trim().replace(/\s+/gu, ' ')
  return label || BRAIN_PREDICATE_LABELS[link.predicate].out.toLowerCase()
}
/** True once the link's end date has passed. */
export function brainLinkEnded(link: Pick<BrainLink, 'validTo'>, now: number): boolean {
  return link.validTo !== null && link.validTo <= now
}
/** "Tom Lee took over Ledger billing from Rina Okafor (since 2026-09-01)". */
export function brainLinkSentence(link: BrainLink, subject: string, object: string): string {
  const sentence = `${subject} ${brainLinkWords(link)} ${object}`
  const from = link.validFrom === null ? null : day(link.validFrom)
  const to = link.validTo === null ? null : day(link.validTo)
  if (from && to) return `${sentence} (${from} to ${to})`
  if (from) return `${sentence} (since ${from})`
  if (to) return `${sentence} (until ${to})`
  return sentence
}
function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}
