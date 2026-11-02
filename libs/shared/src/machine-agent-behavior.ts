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
/** Where an Agent setting lives in pi's settings.json: a key, or a nested group's field. */
export type AgentFieldPath =
  | readonly [key: 'defaultThinkingLevel' | 'hideThinkingBlock' | 'steeringMode' | 'followUpMode']
  | readonly [group: 'compaction' | 'retry', field: string]

/** One Agent setting both machines edit: its place, its control and pi's own default. */
export interface AgentField {
  path: AgentFieldPath
  kind: 'bool' | 'int' | 'mode' | 'thinking'
  /** Whole numbers only: the bounds a Host accepts, with the step the field moves by. */
  min?: number
  max?: number
  step?: number
  /** What pi uses when no settings file sets it (pi `dist/core/settings-defaults.js`). */
  piDefault: boolean | number | string
}

/**
 * The single source for the Agent section's pi settings, on every machine.
 * The bounds are the Host validator's (below), so a value one machine saves
 * is never refused or dropped by another.
 */
export const AGENT_FIELDS = {
  defaultThinkingLevel: { path: ['defaultThinkingLevel'], kind: 'thinking', piDefault: 'medium' },
  hideThinkingBlock: { path: ['hideThinkingBlock'], kind: 'bool', piDefault: false },
  steeringMode: { path: ['steeringMode'], kind: 'mode', piDefault: 'one-at-a-time' },
  followUpMode: { path: ['followUpMode'], kind: 'mode', piDefault: 'one-at-a-time' },
  'compaction.enabled': { path: ['compaction', 'enabled'], kind: 'bool', piDefault: true },
  'compaction.reserveTokens': {
    path: ['compaction', 'reserveTokens'],
    kind: 'int',
    min: 0,
    max: 1_000_000,
    step: 1024,
    piDefault: 16384,
  },
  'compaction.keepRecentTokens': {
    path: ['compaction', 'keepRecentTokens'],
    kind: 'int',
    min: 0,
    max: 1_000_000,
    step: 1024,
    piDefault: 20000,
  },
  'retry.enabled': { path: ['retry', 'enabled'], kind: 'bool', piDefault: true },
  'retry.maxRetries': {
    path: ['retry', 'maxRetries'],
    kind: 'int',
    min: 0,
    max: 100,
    step: 1,
    piDefault: 3,
  },
  'retry.baseDelayMs': {
    path: ['retry', 'baseDelayMs'],
    kind: 'int',
    min: 0,
    max: 1_000_000,
    step: 250,
    piDefault: 2000,
  },
} as const satisfies Record<string, AgentField>
export type AgentFieldKey = keyof typeof AGENT_FIELDS

/** The value at `path`, if the settings set it. */
export function agentFieldValue(settings: Record<string, unknown>, path: AgentFieldPath): unknown {
  const [key, field] = path
  const value = settings[key]
  if (field === undefined) return value
  return machineRecord(value) ? value[field] : undefined
}

/**
 * `settings` with `path` set to `value`, or cleared when `value` is undefined.
 * A nested group merges one level and is dropped once empty, as both
 * machines write it.
 */
export function withAgentField(
  settings: Record<string, unknown>,
  path: AgentFieldPath,
  value: unknown,
): Record<string, unknown> {
  const [key, field] = path
  const next = { ...settings }
  if (field !== undefined) {
    const group = { ...(machineRecord(settings[key]) ? settings[key] : {}), [field]: value }
    if (value === undefined) delete group[field]
    value = Object.keys(group).length > 0 ? group : undefined
  }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

const intBounds = (key: string, field: string): AgentField | undefined =>
  (AGENT_FIELDS as Record<string, AgentField>)[`${key}.${field}`]
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
            v >= (intBounds(key, field)?.min ?? 0) &&
            v <= (intBounds(key, field)?.max ?? 0)),
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
