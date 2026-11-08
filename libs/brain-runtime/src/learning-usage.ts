import type { BrainLearningUsage } from '@phosphor/shared/brain-learning'

/** Keep only response token counts; never propagate arbitrary provider error fields. */
export function learningFailureUsage(error: unknown): BrainLearningUsage | null {
  if (!error || typeof error !== 'object' || !('learningUsage' in error)) return null
  const raw = error.learningUsage
  if (!raw || typeof raw !== 'object') return null
  const count = (key: keyof BrainLearningUsage) => {
    const value = (raw as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }
  const output = count('output'),
    reasoning = count('reasoning')
  return {
    input: count('input'),
    output,
    cacheRead: count('cacheRead'),
    cacheWrite: count('cacheWrite'),
    reasoning: output !== null && reasoning !== null && reasoning <= output ? reasoning : null,
  }
}
