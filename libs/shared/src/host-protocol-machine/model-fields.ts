import type { ModelCost, ThinkingLevelMap } from '../rpc'
import { ALL_THINKING_LEVELS } from '../thinking'

type FieldResult<T> = { ok: true; value: T } | { ok: false }

const fieldRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Success includes absent and explicit-null maps; neither is a validation failure. */
export function parseModelThinkingLevelMap(
  value: unknown,
): FieldResult<ThinkingLevelMap | null | undefined> {
  if (value === undefined || value === null) return { ok: true, value }
  if (
    !fieldRecord(value) ||
    Object.keys(value).some((key) => !ALL_THINKING_LEVELS.some((level) => level === key))
  )
    return { ok: false }
  const map: ThinkingLevelMap = {}
  for (const level of ALL_THINKING_LEVELS) {
    const mapped = value[level]
    if (mapped === undefined) continue
    if (
      mapped !== null &&
      (typeof mapped !== 'string' ||
        mapped.length === 0 ||
        mapped.length > 100 ||
        mapped.includes('\0'))
    )
      return { ok: false }
    map[level] = mapped
  }
  return { ok: true, value: map }
}

export function parseModelCost(value: unknown): FieldResult<ModelCost | undefined> {
  if (value === undefined) return { ok: true, value }
  if (
    !fieldRecord(value) ||
    ![value.input, value.output, value.cacheRead, value.cacheWrite].every(
      (cost) => typeof cost === 'number' && Number.isFinite(cost) && cost >= 0,
    ) ||
    typeof value.input !== 'number' ||
    typeof value.output !== 'number' ||
    typeof value.cacheRead !== 'number' ||
    typeof value.cacheWrite !== 'number'
  )
    return { ok: false }
  return {
    ok: true,
    value: {
      input: value.input,
      output: value.output,
      cacheRead: value.cacheRead,
      cacheWrite: value.cacheWrite,
    },
  }
}
