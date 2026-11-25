/**
 * Explorer reads. Every one is bounded, so the Brain page stays fast at 100k entities and a
 * million memories: nothing here returns the whole graph.
 */
import type {
  BrainEntity,
  BrainEntityKind,
  BrainLink,
  BrainMemory,
  BrainMemoryState,
  BrainMemoryType,
  BrainOrigin,
  BrainPredicate,
  BrainQuote,
} from './brain'

/** An entity with the counts a list row or graph node shows. */
export interface BrainEntitySummary extends BrainEntity {
  memories: number
  connections: number
}
/** A bounded piece of the graph: an overview of hubs, or one entity's neighbourhood. */
export interface BrainGraph {
  nodes: BrainEntitySummary[]
  /** Links on the map now. */
  links: BrainLink[]
  /** The centre's ended links, drawn as history; empty for the overview. */
  ended: BrainLink[]
  /** The selected entity, or null for the overview. */
  centerId: string | null
  truncated: boolean
}
/** One neighbour through one predicate and direction, however many memories state it. */
export interface BrainConnection {
  entity: BrainEntitySummary
  /** The newest link to this neighbour through this predicate and direction. */
  link: BrainLink
  /** How many memories support this connection. */
  supports: number
}
/** Neighbours through one predicate in one direction: `out` reads entity → neighbour. */
export interface BrainConnectionGroup {
  predicate: BrainPredicate
  direction: 'out' | 'in'
  /** Distinct neighbours, not supporting rows. */
  total: number
  items: BrainConnection[]
  /** Connection cursor, null when `items` is everything. */
  next: string | null
}
export interface BrainConnectionPage {
  items: BrainConnection[]
  next: string | null
}
export interface BrainEntityView {
  entity: BrainEntitySummary
  /** Lanes its current memories came from, newest first, with how many each holds. */
  sources: (BrainOrigin & { memories: number })[]
  /** Newest observation among its current memories. */
  lastLearnedAt: number | null
  /** Current relations only. */
  groups: BrainConnectionGroup[]
  /** Ended relations, newest end first, at most 20. */
  ended: BrainConnection[]
  /** Entities named in its memories with no link saying how they relate, at most 12. */
  together: { entity: BrainEntitySummary; shared: number }[]
  togetherMore: number
  memoryCounts: Record<BrainMemoryType, number>
  /** Labels of entities merged into this one. */
  merged: string[]
}
export interface BrainMemoryFilter {
  types?: BrainMemoryType[]
  /** Defaults to active and disputed. */
  states?: BrainMemoryState[]
  sessionId?: string
}
export interface BrainMemoryPage {
  memories: BrainMemory[]
  /** Every entity the memories reference. */
  entities: BrainEntity[]
  next: string | null
}
export interface BrainMemoryDetail {
  memory: BrainMemory
  quotes: BrainQuote[]
  /** The quote behind each link, by link id. */
  linkQuotes: Record<string, BrainQuote[]>
  entities: BrainEntity[]
  /** Memories this one replaced, newest first, and the one that replaced it. */
  history: BrainMemory[]
  /** Memories it conflicts with, or that an open question was resolved by. */
  related: { kind: 'conflicts' | 'resolves' | 'supersedes'; memory: BrainMemory }[]
  /** The lane file, when it still exists, so "Open in lane" can jump there. */
  sourcePath: string | null
  /** How often lanes recalled it and flagged it. Shown, never used to rank. */
  use: { recalled: number; lastRecalledAt: number | null; flagged: number }
}
/** Typeahead: entities first, then memories. */
export interface BrainFindResult {
  entities: BrainEntitySummary[]
  memories: BrainMemory[]
  /** Entities the memories reference that are not already listed. */
  referenced: BrainEntity[]
  degradation: string[]
}
/**
 * Browse order. `connected` is v5's connection rank; `recent` is the newest observation among an
 * entity's current memories (none last); `name` is the label without case, then id.
 */
export const BRAIN_ENTITY_SORTS = ['connected', 'recent', 'name'] as const
export type BrainEntitySort = (typeof BRAIN_ENTITY_SORTS)[number]
export interface BrainEntityPage {
  items: { entity: BrainEntity; memories: number }[]
  more: boolean
  kinds: BrainEntityKind[]
  /** Entities per populated kind, whatever the kind filter. */
  counts: Partial<Record<BrainEntityKind, number>>
  /** Entities matching the kind filter. */
  total: number
}
