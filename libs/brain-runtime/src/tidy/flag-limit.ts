import type { BrainFlagResponse } from '@phosphor/shared/brain'

export function createBrainFlagLimit(now = () => performance.now()) {
  const times: number[] = []
  return (): BrainFlagResponse | undefined => {
    const at = now()
    while (times.length && times[0]! <= at - 60_000) times.shift()
    if (times.length >= 10)
      return {
        status: 'limit',
        message:
          'Brain accepts ten flag requests per minute. Try again shortly; Brain knowledge has not changed.',
      }
    times.push(at)
    return undefined
  }
}

/** Both ingress paths run in the Brain service process. Never allocate this per lane. */
export const brainFlagLimit = createBrainFlagLimit()
