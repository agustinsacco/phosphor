import type { StoppedComposer } from '@phosphor/shared/host-protocol'
import type { SessionEntryLike } from '@phosphor/session-runtime/pi/session-context'
import { ALL_THINKING_LEVELS } from '@phosphor/shared/thinking'

function model(provider: unknown, id: unknown) {
  return typeof provider === 'string' &&
    provider.length > 0 &&
    provider.length <= 200 &&
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 200
    ? { provider, id }
    : undefined
}

function tokens(usage: unknown) {
  if (!usage || typeof usage !== 'object') return
  const { totalTokens, input, output, cacheRead, cacheWrite } = usage as Record<string, unknown>
  const count = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (count(totalTokens) && totalTokens > 0) return totalTokens
  if (count(input) && count(output) && count(cacheRead) && count(cacheWrite)) {
    const sum = input + output + cacheRead + cacheWrite
    if (count(sum)) return sum
  }
}

/** Small validated facts only: the transcript index must not keep assistant payloads. */
export function indexComposer(entry: SessionEntryLike): StoppedComposer | undefined {
  if (entry.type === 'model_change') {
    const selected = model(entry.provider, entry.modelId)
    return selected && { model: selected }
  }
  if (entry.type === 'thinking_level_change') {
    const level = ALL_THINKING_LEVELS.find((candidate) => candidate === entry.thinkingLevel)
    return level && { thinkingLevel: level }
  }
  const raw = entry.message
  if (entry.type !== 'message' || !raw || typeof raw !== 'object') return
  const m = raw as Record<string, unknown>
  if (m.role !== 'assistant') return
  const selected = model(m.provider, m.model)
  const usage = m.stopReason === 'error' || m.stopReason === 'aborted' ? undefined : tokens(m.usage)
  return {
    ...(selected ? { model: selected } : {}),
    ...(usage !== undefined ? { tokens: usage } : {}),
  }
}

/** A saved reading belongs to one model and one uncompacted context. */
export function branchComposer(
  path: readonly (SessionEntryLike & { composer?: StoppedComposer })[],
) {
  let model: StoppedComposer['model']
  let thinkingLevel: StoppedComposer['thinkingLevel']
  let tokens: StoppedComposer['tokens']
  for (const entry of path) {
    const selected = entry.composer?.model
    if (selected) {
      if (selected.provider !== model?.provider || selected.id !== model.id) tokens = undefined
      model = selected
    }
    thinkingLevel = entry.composer?.thinkingLevel ?? thinkingLevel
    tokens = entry.type === 'compaction' ? undefined : (entry.composer?.tokens ?? tokens)
  }
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  }
}
