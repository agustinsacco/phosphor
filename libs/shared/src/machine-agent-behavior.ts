import { machineRecord } from './host-protocol-machine'

export interface MachineAgentBehavior {
  hideThinkingBlock?: boolean
  steeringMode?: 'all' | 'one-at-a-time'
  followUpMode?: 'all' | 'one-at-a-time'
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number }
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number }
}
export const AGENT_BEHAVIOR_KEYS = [
  'hideThinkingBlock',
  'steeringMode',
  'followUpMode',
  'compaction',
  'retry',
] as const
/** The reviewed fields of each nested group; anything else in the file stays on disk. */
export const AGENT_BEHAVIOR_FIELDS: Record<'compaction' | 'retry', readonly string[]> = {
  compaction: ['enabled', 'reserveTokens', 'keepRecentTokens'],
  retry: ['enabled', 'maxRetries', 'baseDelayMs'],
}
const nestedFields = (key: string): readonly string[] =>
  key === 'compaction' || key === 'retry' ? AGENT_BEHAVIOR_FIELDS[key] : []
export function validAgentBehavior(key: string, value: unknown): boolean {
  if (key === 'hideThinkingBlock') return typeof value === 'boolean'
  if (key === 'steeringMode' || key === 'followUpMode')
    return value === 'all' || value === 'one-at-a-time'
  const fields = nestedFields(key)
  return (
    fields.length > 0 &&
    machineRecord(value) &&
    Object.entries(value).every(
      ([field, v]) =>
        fields.includes(field) &&
        (field === 'enabled'
          ? typeof v === 'boolean'
          : typeof v === 'number' &&
            Number.isSafeInteger(v) &&
            v >= 0 &&
            v <= (field === 'maxRetries' ? 100 : 1_000_000)),
    )
  )
}
/** Only reviewed fields leave the Host. Unknown nested settings stay on disk. */
export function projectAgentBehavior(raw: Record<string, unknown>): MachineAgentBehavior {
  const result: Record<string, unknown> = {}
  for (const key of AGENT_BEHAVIOR_KEYS) {
    const value = raw[key]
    if (key === 'compaction' || key === 'retry') {
      if (!machineRecord(value)) continue
      const fields = AGENT_BEHAVIOR_FIELDS[key]
      const projected = Object.fromEntries(
        fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]),
      )
      if (validAgentBehavior(key, projected)) result[key] = projected
    } else if (validAgentBehavior(key, value)) result[key] = value
  }
  return result as MachineAgentBehavior
}

/**
 * A patch value for a behavior key: valid, or `null` to clear it. In a nested
 * group a field may be `null` too; it must still be a reviewed field.
 */
export function validAgentBehaviorPatch(key: string, value: unknown): boolean {
  if (value === null) return true
  const fields = nestedFields(key)
  if (!fields.length || !machineRecord(value)) return validAgentBehavior(key, value)
  const set = Object.entries(value).filter(([, v]) => v !== null)
  return (
    Object.keys(value).every((field) => fields.includes(field)) &&
    validAgentBehavior(key, Object.fromEntries(set))
  )
}
