import type {
  BrainEntityKind,
  BrainExtractionOutcome,
  BrainMemoryType,
  BrainEpistemicKind,
  BrainPredicate,
} from '@phosphor/shared/brain'
import type { EntityKey, ProposalEntity } from '@phosphor/memory-engine/types'
import type { TranscriptWindow } from './windows'
import type { ClaimHold } from './stage-hold'

export interface StageEntity {
  ref: string
  label: string
  kind: BrainEntityKind
  aliases: string[]
  description: string
  keys: EntityKey[]
  /** The person who is the user, as the conversation names them. At most one per part. */
  user?: true
  /** Trusted mark carried from folded parts into the proposal. */
  owner?: true
}
export interface StageQuote {
  segment: string
  quote: string
}
export interface StageLink {
  label?: string
  validFrom?: number | null
  validTo?: number | null
  subject: string
  predicate: BrainPredicate
  object: string
  quote: string
  segment: string
}
export interface StageClaim {
  ref: string
  text: string
  type: BrainMemoryType
  epistemic: BrainEpistemicKind
  mentions: string[]
  links: StageLink[]
  quotes: StageQuote[]
  validFrom: number | null
  validTo: number | null
  branch: boolean
  importance?: 0 | 1 | 2
  /** Absent in parts checkpointed before holds existed. */
  hold?: ClaimHold | null
}
export interface StageParent {
  entity: string
  status: 'stated' | 'not_stated'
  claim: string | null
}
export interface StageExtraction {
  entities: StageEntity[]
  claims: StageClaim[]
  parents: StageParent[]
  /** Rejected source-derived metadata, retained through checkpoints for inspection. */
  outcomes?: BrainExtractionOutcome[]
}
export interface ExtractedPart {
  key: string
  window: TranscriptWindow
  extraction: StageExtraction
}
export type Registry = StageEntity[]
export type StageAsk = <T>(
  stage: 'extract' | 'links' | 'identity' | 'reconcile',
  part: number,
  prompt: string,
  validate: (answer: string) => T,
  entryIds?: string[],
  input?: StageInput,
) => Promise<T>
export interface IdentityResult {
  entities: ProposalEntity[]
  redirects: Map<string, string>
}

export interface SegmentInput {
  context?: boolean
  entryId: string
  index: number
  start: number
  end: number
}
export type LinkEntity = Pick<StageEntity, 'ref' | 'kind' | 'label' | 'description'>
export interface LinkRow {
  ref: string
  text: string
  mentions: string[]
  links: StageLink[]
  excerpts: { segment: string; text: string }[]
}
export interface LinksInput {
  entities: LinkEntity[]
  rows: (Omit<LinkRow, 'excerpts'> & {
    excerpts: (SegmentInput & { segment: string })[]
  })[]
}
export interface StageLinks {
  links: (StageLink & { claim: string })[]
  outcomes: BrainExtractionOutcome[]
}
export interface StageInput {
  links?: LinksInput
  part?: number
  total?: number
  kept?: string[]
  registry?: Registry
  rows?: unknown[]
  segments?: SegmentInput[]
}
