import type { BrainEntityKind, BrainMemoryType, BrainStatus } from './brain'
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
  foldRefusal?: 'applicability' | 'history' | null
  revision: number
}
export type BrainTidyAction =
  | { kind: 'merge'; survivorId: string }
  | { kind: 'fold'; survivorId: string }
  | { kind: 'dispute' }
  | { kind: 'replace'; newerId: string }
  | { kind: 'forget' }
  | { kind: 'keep' }
export interface BrainTidyOperation {
  id: string
  kind: 'merge' | 'fold' | 'dispute' | 'replace'
  automatic: boolean
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
  cappedBuckets: number
  startedAt: number | null
  finishedAt: number | null
}
export interface BrainTidyRun {
  state: 'queued' | 'sweeping' | 'checking' | 'done' | 'cancelled' | 'failed'
  checked: number
  total: number
  suggestions: number
  folded: number
  startedAt: number
  finishedAt: number | null
  message: string | null
  error: string | null
}
export interface BrainTidySummary {
  open: number
  newestSuggestionAt: number | null
  running: boolean
  automaticFolds: number
  newestAutomaticFoldAt: number | null
}
export interface BrainTidyPage {
  items: BrainTidySuggestion[]
  next: string | null
  counts: Record<BrainTidyKind, number>
  revision: number
  coverage: BrainTidyCoverage
  run: BrainTidyRun | null
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
/** Bounded model inputs. All strings are untrusted stored data, never instructions. */
export type BrainTidyCard =
  | {
      type: 'memory'
      id: string
      sentence: string
      memoryType: BrainMemoryType
      scope: string
      branch: string | null
      validFrom: number | null
      validTo: number | null
      observedAt: number
      entities: string[]
      quotes: string[]
    }
  | {
      type: 'entity'
      id: string
      name: string
      aliases: string[]
      kind: BrainEntityKind
      description: string
      memories: number
      neighbours: { name: string; link: string }[]
    }
export interface BrainTidyPair {
  suggestionId: string
  subjects: [BrainTidyCard, BrainTidyCard]
}
export interface BrainTidyJudgement {
  suggestionId: string
  verdict: BrainTidyVerdict
  model: string
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
  if (['merge', 'fold', 'replace'].includes(String(row.kind))) {
    if (
      Object.keys(row).length === 2 &&
      typeof row[key] === 'string' &&
      row[key].length > 0 &&
      row[key].length <= 200
    )
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
    open: 0,
    newestSuggestionAt: null,
    running: false,
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
    cappedBuckets: 0,
    startedAt: null,
    finishedAt: null,
  }
}
export function emptyBrainTidyPage(revision = 0): BrainTidyPage {
  return {
    items: [],
    next: null,
    counts: { same_entity: 0, same_memory: 0, conflict: 0, flagged: 0 },
    revision,
    coverage: emptyBrainTidyCoverage(),
    run: null,
  }
}

export interface BrainTidyFlagResult {
  status: 'filed' | 'already_flagged' | 'limit' | 'unavailable'
  suggestionId: string | null
}
