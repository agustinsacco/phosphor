import type { BrainLaneRef, BrainPrefs } from '@phosphor/shared/brain'
import type { BrainApi, BrainService } from '@phosphor/brain-runtime/types'
import { handle } from './handle'

const fail = (message: string): never => {
  throw new Error(message)
}
const text = (value: unknown, max = 4096): string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : fail('Invalid Brain request.')

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

/** Proposal indexes: unique, in range of what a proposal can hold. Null rejects the proposal. */
export function checkKeep(value: unknown): number[] | null {
  if (value === null) return null
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    new Set(value).size !== value.length ||
    value.some((index) => !Number.isInteger(index) || index < 0 || index >= 200)
  )
    fail('Invalid review selection.')
  return value as number[]
}

const revisionOf = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : fail('Invalid Brain revision.')

/** Desktop-only. Lazy acquisition keeps a failed startup retryable. */
export function registerBrainHandlers(service: () => Promise<BrainService>): void {
  const api = async (): Promise<BrainApi> => (await service()).api
  handle('brain:status', async () => (await api()).status())
  handle('brain:setPrefs', async (_event, prefs) => (await api()).setPrefs(checkPrefs(prefs)))
  handle('brain:download', async () => (await api()).download())
  handle('brain:removeModel', async () => (await api()).removeModel())
  handle('brain:queue', async (_event, lane) => (await api()).queue(checkLane(lane)))
  handle('brain:cancel', async (_event, id) => (await api()).cancel(text(id, 200)))
  handle('brain:extraction', async (_event, id) => (await api()).extraction(text(id, 200)))
  handle('brain:proposal', async (_event, id) => (await api()).proposal(text(id, 200)))
  handle('brain:review', async (_event, id, keep, revision) =>
    (await api()).review(text(id, 200), checkKeep(keep), revisionOf(revision)),
  )
  handle('brain:knowledge', async () => (await api()).knowledge())
  handle('brain:memory', async (_event, id) => (await api()).memory(text(id, 200)))
  handle('brain:forget', async (_event, id) => (await api()).forget(text(id, 200)))
}
