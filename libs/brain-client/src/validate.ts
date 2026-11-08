import type {
  BrainAgentMap,
  BrainAgentMethod,
  BrainClaim,
  BrainEntity,
  BrainEvidence,
  BrainSearchHit,
  BrainSearchResult,
} from '@phosphor/shared/brain'

/**
 * Minimal structural checks on successful agent results: the fields callers
 * format or branch on, not a full schema. The service owns the full contract.
 */
type Guard<T> = (value: unknown) => value is T

const SEARCH_STATUSES = new Set([
  'ok',
  'no_match',
  'partial',
  'unavailable',
  'needs_disambiguation',
])
const EVIDENCE_ROLES = new Set(['user', 'toolResult', 'assistant'])
const CLAIM_STATES = new Set(['active', 'contested', 'superseded'])
const EPISTEMIC_KINDS = new Set(['observed', 'reported', 'inferred'])
const JOB_STATES = new Set(['queued', 'running', 'proposed', 'failed', 'cancelled', 'interrupted'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value: unknown): value is T[] => Array.isArray(value) && value.every(guard)
}

const isString: Guard<string> = (value): value is string => typeof value === 'string'
const isStrings = arrayOf(isString)

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string')
}

function isRevision(value: Record<string, unknown>): boolean {
  return isNumber(value.graphRevision) && isNumber(value.policyEpoch)
}

export const isBrainEvidence: Guard<BrainEvidence> = (value): value is BrainEvidence =>
  isRecord(value) &&
  hasStrings(value, ['id', 'scope', 'sessionId', 'entryId', 'label', 'text', 'hash']) &&
  isNullableString(value.parentId) &&
  isNullableString(value.branch) &&
  isStrings(value.rootIds) &&
  EVIDENCE_ROLES.has(value.role as string) &&
  isNumber(value.observedAt)

const isCitation = (value: unknown): boolean =>
  isRecord(value) && hasStrings(value, ['evidenceId', 'quote'])

export const isBrainClaim: Guard<BrainClaim> = (value): value is BrainClaim =>
  isRecord(value) &&
  hasStrings(value, ['id', 'scope', 'subjectId', 'predicate', 'summary']) &&
  isNullableString(value.objectId) &&
  isNullableString(value.literal) &&
  EPISTEMIC_KINDS.has(value.kind as string) &&
  CLAIM_STATES.has(value.state as string) &&
  Array.isArray(value.citations) &&
  value.citations.every(isCitation) &&
  isStrings(value.conflictIds) &&
  isNullableNumber(value.validFrom) &&
  isNullableNumber(value.validTo) &&
  isNumber(value.recordedAt)

const isBrainEntity: Guard<BrainEntity> = (value): value is BrainEntity =>
  isRecord(value) && hasStrings(value, ['id', 'scope', 'label', 'kind']) && isStrings(value.aliases)

const isSearchHit: Guard<BrainSearchHit> = (value): value is BrainSearchHit =>
  isRecord(value) &&
  isBrainClaim(value.claim) &&
  arrayOf(isBrainEvidence)(value.evidence) &&
  isStrings(value.reasons) &&
  isNumber(value.score)

export const isBrainSearchResult: Guard<BrainSearchResult> = (value): value is BrainSearchResult =>
  isRecord(value) &&
  isRevision(value) &&
  SEARCH_STATUSES.has(value.status as string) &&
  arrayOf(isSearchHit)(value.results) &&
  arrayOf(isBrainEntity)(value.entities) &&
  isStrings(value.degradation) &&
  typeof value.truncated === 'boolean'

const isJobBundle: Guard<BrainAgentMap['job']['result']> = (
  value,
): value is BrainAgentMap['job']['result'] => {
  if (!isRecord(value) || !arrayOf(isBrainEvidence)(value.evidence)) return false
  const job = value.job
  return (
    isRecord(job) &&
    isRevision(job) &&
    hasStrings(job, ['id', 'scope']) &&
    JOB_STATES.has(job.state as string) &&
    isNumber(job.fence) &&
    isStrings(job.evidenceIds)
  )
}

const isProposalReceipt: Guard<BrainAgentMap['propose']['result']> = (
  value,
): value is BrainAgentMap['propose']['result'] =>
  isRecord(value) && typeof value.proposalId === 'string' && value.proposalId.length > 0

export const BRAIN_RESULT_VALIDATORS: {
  [M in BrainAgentMethod]: Guard<BrainAgentMap[M]['result']>
} = {
  search: isBrainSearchResult,
  read: isBrainEvidence,
  brief: isBrainSearchResult,
  job: isJobBundle,
  propose: isProposalReceipt,
}
