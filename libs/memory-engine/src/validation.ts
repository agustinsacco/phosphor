import { isAbsolute } from 'node:path'
import { BRAIN_PREDICATES } from '@phosphor/shared/brain'
import type {
  BrainCapture,
  BrainCorrection,
  BrainModel,
  BrainPrefs,
  BrainProposalInput,
  BrainQuery,
  BrainRevision,
} from '@phosphor/shared/brain'

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function fields(value: object, allowed: string[]): void {
  check(
    Object.keys(value).every((key) => allowed.includes(key)),
    'Unknown memory field',
  )
}
export function text(value: unknown, max = 4096, empty = false): asserts value is string {
  check(
    typeof value === 'string' &&
      value.length <= max &&
      (empty || value.trim().length > 0) &&
      !value.includes('\0'),
    'Invalid memory text',
  )
}
export function list(value: unknown, max: number): asserts value is unknown[] {
  check(Array.isArray(value) && value.length <= max, 'Memory list exceeds bounds')
}
export function strings(value: unknown, max = 200): asserts value is string[] {
  list(value, max)
  for (const item of value) text(item)
}
export function timestamp(value: unknown, nullable = false): void {
  check(
    (nullable && value === null) || (typeof value === 'number' && Number.isSafeInteger(value)),
    'Invalid memory timestamp',
  )
}
export function interval(from: unknown, to: unknown): void {
  timestamp(from, true)
  timestamp(to, true)
  check(from === null || to === null || Number(from) < Number(to), 'Invalid validity interval')
}
export function bounded(value: unknown, max = 1_000_000): void {
  check(Buffer.byteLength(JSON.stringify(value) ?? '') <= max, 'Memory input exceeds bounds')
}
export function model(value: BrainModel): void {
  check(value && typeof value === 'object', 'Invalid processor model')
  text(value.provider, 200)
  text(value.id, 500)
}
export function revision(value: BrainRevision): void {
  check(value && typeof value === 'object', 'Invalid revision')
  for (const number of [value.policyEpoch, value.graphRevision]) {
    check(Number.isSafeInteger(number) && number >= 0, 'Invalid revision')
  }
}
export function preferences(value: BrainPrefs): void {
  bounded(value)
  check(
    value && typeof value.enabled === 'boolean' && typeof value.recall === 'boolean',
    'Invalid consent',
  )
  strings(value.workspaces, 100)
  check(
    value.workspaces.every((scope) => isAbsolute(scope)),
    'Workspace scopes must be absolute',
  )
  check(new Set(value.workspaces).size === value.workspaces.length, 'Duplicate scope')
  check(
    Number.isInteger(value.retentionDays) &&
      value.retentionDays >= 1 &&
      value.retentionDays <= 3650,
    'Invalid retention',
  )
  if (value.processor !== null) model(value.processor)
}
export function evidence(value: BrainCapture): void {
  bounded(value, 300_000)
  check(value && typeof value === 'object', 'Invalid capture')
  text(value.scope)
  text(value.sessionId)
  text(value.entryId)
  text(value.label)
  text(value.text, 250_000)
  strings(value.rootIds, 100)
  check(value.rootIds.length > 0, 'Evidence needs original roots')
  if (value.parentId !== null) text(value.parentId)
  if (value.branch !== null) text(value.branch)
  timestamp(value.observedAt)
  check(['user', 'toolResult', 'assistant'].includes(value.role), 'Invalid evidence role')
}
const entityKinds = [
  'person',
  'team',
  'project',
  'customer',
  'component',
  'incident',
  'contract',
  'concept',
]
export function proposal(value: BrainProposalInput): void {
  bounded(value)
  check(value && typeof value === 'object', 'Invalid proposal')
  list(value.entities, 100)
  list(value.claims, 100)
  text(value.rationale, 8000)
  check(value.claims.length > 0, 'Empty proposal')
  const keys = new Set<string>()
  for (const entity of value.entities) {
    text(entity.key, 200)
    text(entity.label, 500)
    strings(entity.aliases, 30)
    strings(entity.evidenceIds)
    check(
      entity.evidenceIds.length > 0 && entityKinds.includes(entity.kind),
      'Entity lacks evidence or kind',
    )
    check(!keys.has(entity.key), 'Duplicate entity key')
    keys.add(entity.key)
    if (entity.existingId !== undefined) text(entity.existingId)
  }
  for (const claim of value.claims) {
    text(claim.subject, 200)
    text(claim.summary, 8000)
    check(BRAIN_PREDICATES.includes(claim.predicate), 'Invalid relationship predicate')
    check(['observed', 'reported', 'inferred'].includes(claim.kind), 'Invalid epistemic kind')
    check(
      (claim.object !== undefined) !== (claim.literal !== undefined),
      'Claim needs exactly one object or literal',
    )
    if (claim.object !== undefined) text(claim.object, 200)
    if (claim.literal !== undefined) text(claim.literal, 8000)
    list(claim.citations, 20)
    check(claim.citations.length > 0, 'Claim lacks citations')
    for (const citation of claim.citations) {
      text(citation.evidenceId)
      text(citation.quote, 8000)
    }
    interval(claim.validFrom, claim.validTo)
    if (claim.supersedes !== undefined) text(claim.supersedes)
  }
}
export function correction(value: BrainCorrection): void {
  bounded(value)
  check(value && typeof value === 'object', 'Invalid correction')
  fields(value, [
    'subjectId',
    'predicate',
    'objectId',
    'literal',
    'summary',
    'validFrom',
    'validTo',
    'reason',
  ])
  text(value.subjectId)
  text(value.summary, 8000)
  text(value.reason, 8000)
  check(BRAIN_PREDICATES.includes(value.predicate), 'Invalid relationship predicate')
  check(
    (value.objectId === null) !== (value.literal === null),
    'Correction needs exactly one object or literal',
  )
  if (value.objectId !== null) text(value.objectId)
  if (value.literal !== null) text(value.literal, 8000)
  interval(value.validFrom, value.validTo)
}
export function query(value: BrainQuery & { branch?: string | null }): void {
  bounded(value, 50_000)
  check(value && typeof value === 'object', 'Invalid query')
  text(value.query, 2000, true)
  if (value.branch !== undefined && value.branch !== null) text(value.branch, 1000)
  if (value.entityIds !== undefined) strings(value.entityIds, 30)
  if (value.scopes !== undefined) strings(value.scopes, 100)
  if (value.validAt !== undefined) timestamp(value.validAt)
  if (value.knownAt !== undefined) timestamp(value.knownAt)
  if (value.mode !== undefined)
    check(['lexical', 'hybrid'].includes(value.mode), 'Invalid search mode')
  for (const [number, maximum] of [
    [value.limit, 50],
    [value.tokenBudget, 16000],
  ]) {
    if (number !== undefined)
      check(Number.isInteger(number) && number > 0 && number <= maximum!, 'Invalid search bound')
  }
}
export function vector(value: number[]): void {
  list(value, 4096)
  check(
    value.length > 0 &&
      value.every((number) => typeof number === 'number' && Number.isFinite(number)),
    'Invalid vector',
  )
  check(
    value.some((number) => number !== 0),
    'Zero vector',
  )
}
