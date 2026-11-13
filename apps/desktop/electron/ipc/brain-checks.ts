import {
  BRAIN_MEMORY_STATES,
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  type BrainLaneRef,
  type BrainMemoryFilter,
  type BrainPredicate,
  type BrainPrefs,
} from '@phosphor/shared/brain'
import type { BrainReviewDecision } from '@phosphor/shared/brain-review'

/** Renderer input is untrusted: every Brain argument is checked here before it reaches the API. */
export const fail = (message: string): never => {
  throw new Error(message)
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

export const text = (value: unknown, max = 4096): string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : fail('Invalid Brain request.')
export const id = (value: unknown): string => text(value, 200)

/** Exactly the three switches; anything else is refused rather than stored. */
export function checkPrefs(value: unknown): BrainPrefs {
  const prefs = value as Partial<Record<keyof BrainPrefs, unknown>>
  if (
    !prefs ||
    typeof prefs !== 'object' ||
    Object.keys(prefs).sort().join() !== 'enabled,recall,review' ||
    Object.values(prefs).some((flag) => typeof flag !== 'boolean')
  )
    fail('Invalid Brain settings.')
  return prefs as BrainPrefs
}

export function checkLane(value: unknown): BrainLaneRef {
  const lane = value as Partial<BrainLaneRef> | null
  return { sessionPath: text(lane?.sessionPath), title: text(lane?.title, 500) }
}

const indexes = (value: unknown, max: number): number[] =>
  Array.isArray(value) &&
  value.length <= max &&
  new Set(value).size === value.length &&
  value.every((index) => Number.isInteger(index) && index >= 0 && index < max)
    ? (value as number[])
    : fail('Invalid review selection.')

/** What to save from a proposal. Null rejects it whole. */
export function checkDecision(value: unknown): BrainReviewDecision | null {
  if (value === null) return null
  if (!record(value) || !exactKeys(value, ['memories', 'identities', 'groups']))
    return fail('Invalid review selection.')
  const identities = value.identities
  if (
    !record(identities) ||
    Object.keys(identities).length > 400 ||
    Object.entries(identities).some(
      ([ref, choice]) =>
        ref.length > 64 || typeof choice !== 'string' || !choice || choice.length > 200,
    )
  )
    fail('Invalid review selection.')
  return {
    memories: indexes(value.memories, 400),
    identities: identities as Record<string, string>,
    groups: indexes(value.groups, 100),
  }
}

export const revisionOf = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : fail('Invalid Brain revision.')

export const limitOf = (value: unknown): number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 50
    ? (value as number)
    : fail('Invalid Brain request.')

export const hopsOf = (value: unknown): 1 | 2 =>
  value === 1 || value === 2 ? value : fail('Invalid Brain request.')

export const predicateOf = (value: unknown): BrainPredicate =>
  (BRAIN_PREDICATES as readonly unknown[]).includes(value)
    ? (value as BrainPredicate)
    : fail('Invalid Brain request.')

export const directionOf = (value: unknown): 'out' | 'in' =>
  value === 'out' || value === 'in' ? value : fail('Invalid Brain request.')

/** Cursors are opaque strings the API issued; null asks for the first page. */
export const cursorOf = (value: unknown): string | null =>
  value === null ? null : text(value, 512)

const members = <T>(value: unknown, allowed: readonly T[]): T[] =>
  Array.isArray(value) &&
  value.length <= allowed.length &&
  value.every((item) => allowed.includes(item as T))
    ? (value as T[])
    : fail('Invalid Brain request.')

export function checkFilter(value: unknown): BrainMemoryFilter {
  if (!record(value) || !exactKeys(value, ['types', 'states', 'sessionId']))
    return fail('Invalid Brain request.')
  return {
    ...(value.types === undefined ? {} : { types: members(value.types, BRAIN_MEMORY_TYPES) }),
    ...(value.states === undefined ? {} : { states: members(value.states, BRAIN_MEMORY_STATES) }),
    ...(value.sessionId === undefined ? {} : { sessionId: id(value.sessionId) }),
  }
}
