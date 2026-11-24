/**
 * Recall: what lanes and Brain Agent ask Brain, and its three answers. A search ranks memories;
 * an expansion shows one entity's relationships and memories; routes show how two connect.
 */
import type { BrainEntity, BrainMemory } from './brain'
import type { BrainLink } from './brain-links'

/** What a lane agent sends. `cwd` ranks the lane's own project first and picks its branch. */
export interface BrainQuery {
  /** Exactly one mode: query, or from (with optional context), or from and to. */
  query?: string
  /** A person or thing to expand: its relationships, then its memories. */
  from?: string
  /** With from: how the two connect. */
  to?: string
  /** Up to 5 names that steer an expansion. */
  context?: string[]
  limit?: number
  sessionId?: string
  cwd?: string
}
/** The shortest explaining path from a seed of the search to a hit. */
export interface BrainTrail {
  /** The seed entity the path starts at. */
  seedId: string
  /** Relation hops from the seed, at most 2. */
  links: BrainLink[]
  /** The entity the memory names at the end of the path. */
  entityId: string
}
export interface BrainHit {
  memory: BrainMemory
  score: number
  /** `exact`: names a queried entity. `linked`: reached by walking the graph from a seed. */
  reasons: ('exact' | 'lexical' | 'semantic' | 'linked')[]
  /** Null when the memory is itself a seed or no short path explains it. */
  trail: BrainTrail | null
}
export interface BrainRecall {
  mode: 'search'
  status: 'ok' | 'no_match' | 'unavailable'
  hits: BrainHit[]
  /** Every entity the hits, focus and trails reference, so tools can print names. */
  entities: BrainEntity[]
  /** Entity ids the query named, or sits inside: "Harbor" names every Harbor project. */
  focus: string[]
  /** Strong matches the limit left out, counted up to 50. */
  more: number
  /** The asking lane's branch; memories for other branches are listed apart. */
  branch: string | null
  degradation: string[]
}
/** One relationship of an expanded entity, written from its side. */
export interface BrainRelationLine {
  link: BrainLink
  /** The entity at the other end. */
  other: BrainEntity
  /** How many memories support it. */
  supports: number
}
export interface BrainExpansion {
  mode: 'expand'
  status: 'ok' | 'no_match' | 'unavailable'
  entity: BrainEntity | null
  /** Other records with this name, when the name was ambiguous. */
  alternatives: BrainEntity[]
  /** Relationships on the map now, then ended ones with their dates. */
  current: BrainRelationLine[]
  /** Current neighbours omitted by each predicate and direction page. */
  currentMore: { predicate: BrainLink['predicate']; direction: 'out' | 'in'; more: number }[]
  ended: BrainRelationLine[]
  /** Entities named in the same memories with no link saying how they relate. */
  together: { entity: BrainEntity; shared: number }[]
  togetherMore: number
  hits: BrainHit[]
  entities: BrainEntity[]
  degradation: string[]
}
/** One step of a route: a stated relationship, or two entities named in the same memory. */
export type BrainRouteStep =
  | { kind: 'relation'; link: BrainLink }
  | { kind: 'together'; fromId: string; toId: string; memoryId: string; shared: number }
export interface BrainRoutes {
  mode: 'route'
  status: 'ok' | 'no_match' | 'unavailable'
  from: BrainEntity | null
  to: BrainEntity | null
  /** Up to three routes, each at most four steps. */
  routes: BrainRouteStep[][]
  /** The memories behind the steps. */
  memories: BrainMemory[]
  entities: BrainEntity[]
}
export type BrainSearchResult = BrainRecall | BrainExpansion | BrainRoutes
