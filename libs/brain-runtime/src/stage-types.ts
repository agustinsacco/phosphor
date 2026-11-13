import type {
  BrainEntityKind,
  BrainExtractionOutcome,
  BrainMemoryType,
  BrainEpistemicKind,
  BrainPredicate,
} from '@phosphor/shared/brain'
import type { EntityKey, ProposalEntity } from '@phosphor/memory-engine/types'
import type { TranscriptWindow } from './windows'

export interface StageEntity {
  ref: string
  label: string
  kind: BrainEntityKind
  aliases: string[]
  description: string
  keys: EntityKey[]
}
export interface StageQuote {
  segment: string
  quote: string
}
export interface StageLink {
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
}
export interface StageParent {
  entity: string
  status: 'stated' | 'not_stated' | 'unclear'
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
  truncated: boolean
}
export type Registry = StageEntity[]
export type StageAsk = <T>(
  stage: 'extract' | 'identity' | 'parents' | 'reconcile',
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
  entryId: string
  index: number
  start: number
  end: number
}
export interface StageInput {
  pass?: 'parents'
  registry?: Registry
  requested?: unknown[]
  rows?: unknown[]
  segments?: SegmentInput[]
}
