import {
  BRAIN_ENTITY_KINDS,
  BRAIN_MEMORY_STATES,
  checkBrainReaderModel,
  checkBrainNeverRead,
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  type BrainEntityKind,
  type BrainLaneRef,
  type BrainMemoryFilter,
  type BrainPredicate,
  type BrainPrefs,
} from '@phosphor/shared/brain'

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

/** Exactly the switches and reader model; anything else is refused rather than stored. */
export function checkPrefs(value: unknown): BrainPrefs {
  const prefs = value as Partial<Record<keyof BrainPrefs, unknown>>
  if (
    !prefs ||
    typeof prefs !== 'object' ||
    Object.keys(prefs).sort().join() !== 'agentAuto,enabled,model,neverRead,recall' ||
    (['enabled', 'recall', 'agentAuto'] as const).some((key) => typeof prefs[key] !== 'boolean')
  )
    fail('Invalid Brain settings.')
  checkBrainReaderModel(prefs.model)
  return { ...(prefs as BrainPrefs), neverRead: checkBrainNeverRead(prefs.neverRead) }
}

/** The title may be empty (an untitled lane); the engine reads the current title from the file. */
export function checkLane(value: unknown): BrainLaneRef {
  const lane = value as Partial<BrainLaneRef> | null
  const title = lane?.title
  if (typeof title !== 'string' || title.length > 500) fail('Invalid Brain request.')
  return { sessionPath: text(lane?.sessionPath), title: title as string }
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

/** Stored descriptions are 1–160 characters once trimmed. */
export const descriptionOf = (value: unknown): string => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 && trimmed.length <= 160
    ? trimmed
    : fail('A description needs 1 to 160 characters.')
}

/** What to split off: 1–200 distinct memory ids, and the new record's label and kind. */
export function checkSplit(
  memoryIds: unknown,
  target: unknown,
): { memoryIds: string[]; target: { label: string; kind: BrainEntityKind } } {
  if (
    !Array.isArray(memoryIds) ||
    memoryIds.length < 1 ||
    memoryIds.length > 200 ||
    new Set(memoryIds).size !== memoryIds.length
  )
    fail('Choose 1 to 200 memories to split off.')
  if (!record(target) || Object.keys(target).sort().join() !== 'kind,label')
    fail('Invalid Brain request.')
  const { label, kind } = target as Record<string, unknown>
  const trimmed = typeof label === 'string' ? label.trim() : ''
  if (!trimmed || trimmed.length > 80) fail('A name needs 1 to 80 characters.')
  if (!(BRAIN_ENTITY_KINDS as readonly unknown[]).includes(kind)) fail('Invalid Brain entity kind.')
  return {
    memoryIds: (memoryIds as unknown[]).map(id),
    target: { label: trimmed, kind: kind as BrainEntityKind },
  }
}
