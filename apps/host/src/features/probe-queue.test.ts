import { expect, it, vi } from 'vitest'
import { probeQueue } from './probe-queue'

it('distinguishes a full queue from a waiting timeout and leaves the slot reusable', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const queue = probeQueue()
    const held = Promise.withResolvers<void>()
    const first = queue(async () => held.promise)
    const waits = Array.from({ length: 7 }, () => queue(async () => 'not called', 1_000).catch((e: unknown) => e))
    await expect(queue(async () => 'not called')).rejects.toMatchObject({ code: 'busy', cause: 'queue-full' })
    await vi.advanceTimersByTimeAsync(1_000)
    for (const error of await Promise.all(waits))
      expect(error).toMatchObject({ cause: 'queue-timeout', phase: 'queue' })
    held.resolve()
    await first
    expect(await queue(async () => 'recovered')).toBe('recovered')
  } finally {
    vi.useRealTimers()
  }
})
