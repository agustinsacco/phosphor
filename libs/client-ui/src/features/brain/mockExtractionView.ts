import type { BrainForkTrace } from '@shared/brain-extraction'

/** A completed call's trace that took `totalMs`. */
export function mockCallTrace(totalMs: number): BrainForkTrace {
  return {
    firstStdoutMs: null,
    firstMessageStartMs: null,
    firstMessageUpdateMs: null,
    agentStarts: 1,
    turns: 1,
    messageUpdates: 1,
    retries: [],
    compactions: [],
    stopReason: 'stop',
    usage: { tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    totalMs,
    reason: 'completed',
  }
}
