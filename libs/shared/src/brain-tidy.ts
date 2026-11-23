import type { BrainStatus } from './brain'
import type { BrainEntityView, BrainMemoryDetail } from './brain-explore'

export const BRAIN_TIDY_KINDS = ['same_entity', 'same_memory', 'conflict', 'flagged'] as const
export type BrainTidyKind = (typeof BRAIN_TIDY_KINDS)[number]
export type BrainTidySource = 'sweep' | 'check' | 'flag'
export type BrainTidyState = 'open' | 'applied' | 'dismissed' | 'cleared'
export type BrainTidyProblem = 'wrong' | 'outdated' | 'duplicate'
export type BrainTidyVerdict =
  | { kind: 'same' | 'different' | 'conflict'; reason: string }
  | { kind: 'replaces'; newerId: string; reason: string }
export interface BrainTidySubject {
  type: 'entity' | 'memory'
  id: string
  label: string
}
export interface BrainTidySuggestion {
  id: string
  kind: BrainTidyKind
  source: BrainTidySource
  state: BrainTidyState
  subjects: BrainTidySubject[]
  reason: string
  verdict: BrainTidyVerdict | null
  model: string | null
  flag: { problem: BrainTidyProblem; sessionId: string; title: string } | null
  createdAt: number
  updatedAt: number
}
export type BrainTidySubjectDetail =
  { type: 'entity'; value: BrainEntityView } | { type: 'memory'; value: BrainMemoryDetail }
export interface BrainTidySuggestionDetail {
  suggestion: BrainTidySuggestion
  subjects: BrainTidySubjectDetail[]
  allowed: BrainTidyAction['kind'][]
  foldRefusal: 'applicability' | 'history' | null
  revision: number
}
export type BrainTidyAction =
  | { kind: 'merge'; survivorId: string }
  | { kind: 'fold'; survivorId: string }
  | { kind: 'dispute' }
  | { kind: 'replace'; newerId: string }
  | { kind: 'forget' }
  | { kind: 'keep' }
  /** "Not the same; remove this name from X": the shared name leaves one record. */
  | { kind: 'unname'; entityId: string; name: string }
/** Who made a change: you on the Brain page, the local pass, or Brain Agent. */
export type BrainChangeWho = 'you' | 'automatic' | 'agent'
export interface BrainTidyOperation {
  id: string
  kind:
    | 'merge'
    | 'fold'
    | 'dispute'
    | 'replace'
    | 'split'
    | 'unname'
    | 'describe'
    /** Brain Agent approved or rejected a read; undo puts it back to waiting. */
    | 'approve'
    | 'reject'
    /** Brain Agent kept both sides of a suggestion; undo reopens it. */
    | 'keep'
    /** Brain Agent replaced a memory with a corrected one citing a source. */
    | 'correct'
    /** Brain Agent erased a memory. Final: only its reason is kept, never its text. */
    | 'erase'
  who: BrainChangeWho
  /** Brain Agent's one-sentence reason; null for your own and automatic changes. */
  reason: string | null
  /** The Defrag run that made it; null outside a run. */
  runId: string | null
  /** The read an approve or reject decided. */
  jobId: string | null
  /** False once undone, for erasures, and once an erasure or the journal limit took its record. */
  undoable: boolean
  summary: string
  createdAt: number
  undoneAt: number | null
  suggestionId: string | null
}
/** Coverage of the current saved pass, not a claim of exhaustive pair comparison. */
export interface BrainTidyCoverage {
  phase: 'entities' | 'memories' | 'done'
  cursor: number
  entities: number
  memories: number
  totalEntities: number
  totalMemories: number
  limitedChecks: number
  startedAt: number | null
  finishedAt: number | null
}
export interface BrainTidySummary {
  automaticFolds: number
  newestAutomaticFoldAt: number | null
}
export interface BrainTidyChanges {
  items: BrainTidyOperation[]
  revision: number
}
/** Forget and Keep do not have an undoable operation. */
export interface BrainTidyMutation extends BrainStatus {
  operationId: string | null
}
export interface BrainTidyTouched {
  entityIds: string[]
  memoryIds: string[]
}
export interface BrainTidySweep {
  coverage: BrainTidyCoverage
  suggestions: number
  folded: number
  operationIds: string[]
}
export interface BrainTidyFlag {
  memoryId: string
  problem: BrainTidyProblem
  reason: string
  sessionId: string
  title: string
}

export function checkBrainTidyAction(value: unknown): BrainTidyAction {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Brain Tidy action.')
  const row = value as Record<string, unknown>
  const key = row.kind === 'merge' || row.kind === 'fold' ? 'survivorId' : 'newerId'
  const bounded = (field: unknown): boolean =>
    typeof field === 'string' && field.length > 0 && field.length <= 200
  if (['merge', 'fold', 'replace'].includes(String(row.kind))) {
    if (Object.keys(row).length === 2 && bounded(row[key])) return value as BrainTidyAction
  } else if (row.kind === 'unname') {
    if (Object.keys(row).length === 3 && bounded(row.entityId) && bounded(row.name))
      return value as BrainTidyAction
  } else if (
    ['dispute', 'forget', 'keep'].includes(String(row.kind)) &&
    Object.keys(row).length === 1
  )
    return value as BrainTidyAction
  throw new Error('Invalid Brain Tidy action.')
}

export function emptyBrainTidySummary(): BrainTidySummary {
  return {
    automaticFolds: 0,
    newestAutomaticFoldAt: null,
  }
}
export function emptyBrainTidyCoverage(): BrainTidyCoverage {
  return {
    phase: 'entities',
    cursor: 0,
    entities: 0,
    memories: 0,
    totalEntities: 0,
    totalMemories: 0,
    limitedChecks: 0,
    startedAt: null,
    finishedAt: null,
  }
}

export interface BrainTidyFlagResult {
  status: 'filed' | 'already_flagged' | 'limit' | 'unavailable'
  suggestionId: string | null
}
