/**
 * Explorer reads. Every one is bounded, so the Brain page stays fast at 100k entities and a
 * million memories: nothing here returns the whole graph.
 */
import type {
  BrainEntity,
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
  links: BrainLink[]
  /** The selected entity, or null for the overview. */
  centerId: string | null
  truncated: boolean
}
/** One neighbour reached by one link. */
export interface BrainConnection {
  entity: BrainEntitySummary
  link: BrainLink
}
/** Neighbours through one predicate in one direction: `out` reads entity → neighbour. */
export interface BrainConnectionGroup {
  predicate: BrainPredicate
  direction: 'out' | 'in'
  total: number
  items: BrainConnection[]
  /** Cursor for `brain:connections`, null when `items` is everything. */
  next: string | null
}
export interface BrainConnectionPage {
  items: BrainConnection[]
  next: string | null
}
export interface BrainEntityView {
  entity: BrainEntitySummary
  /** Lanes its memories came from, newest first. */
  sources: BrainOrigin[]
  groups: BrainConnectionGroup[]
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
}
/** Typeahead: entities first, then memories. */
export interface BrainFindResult {
  entities: BrainEntitySummary[]
  memories: BrainMemory[]
  /** Entities the memories reference that are not already listed. */
  referenced: BrainEntity[]
  degradation: string[]
}
/** Up to three shortest supported routes between two entities. */
export interface BrainPaths {
  paths: BrainLink[][]
  entities: BrainEntity[]
  memories: BrainMemory[]
}
