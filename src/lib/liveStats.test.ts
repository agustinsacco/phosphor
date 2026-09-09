import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStats, Usage } from '@shared/rpc'
import {
  clearLiveStats,
  contextTokensOf,
  hasUsageDeltas,
  liveBilledTokens,
  recordMessageEnd,
  recordPolledStats,
  recordUsageDelta,
} from './liveStats'

/**
 * The trap this module exists to avoid: `message_update.usage` is the CURRENT
 * MESSAGE's usage (verified against pi 0.84.4's source — json-event.js
 * forwards `event.message.usage`), and pi emits one assistant message per
 * tool hop. Summing deltas as if they were session-cumulative would count a
 * turn once per hop; treating a new message's small usage as the session
 * total would make the meter jump backwards. These tests pin the base+current
 * accounting against both mistakes.
 */

const SESSION = 'test-session'

function usage(partial: Partial<Usage>): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...partial }
}

function polled(partial: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionId: 's1',
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 4,
    toolResults: 4,
    totalMessages: 9,
    tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 300, total: 2000 },
    cost: 0.05,
    contextUsage: { tokens: 1800, contextWindow: 200_000, percent: 0.9 },
    ...partial,
  }
}

afterEach(() => clearLiveStats(SESSION))

describe('capability detection', () => {
  it('is off until a delta carries usage — pi < 0.84.2 never flips it', () => {
    expect(hasUsageDeltas(SESSION)).toBe(false)
    recordPolledStats(SESSION, polled())
    expect(hasUsageDeltas(SESSION)).toBe(false)
    recordUsageDelta(SESSION, usage({ input: 10 }))
    expect(hasUsageDeltas(SESSION)).toBe(true)
  })
})

describe('overlay accounting', () => {
  it('returns null before any poll has seeded a baseline', () => {
    expect(recordUsageDelta(SESSION, usage({ input: 10 }))).toBeNull()
  })

  it('adds the streaming message on top of the polled totals', () => {
    recordPolledStats(SESSION, polled())
    const patched = recordUsageDelta(
      SESSION,
      usage({ input: 100, output: 20, cacheRead: 50, cacheWrite: 10 }),
    )
    expect(patched?.tokens).toEqual({
      input: 1100,
      output: 220,
      cacheRead: 550,
      cacheWrite: 310,
      total: 2180,
    })
  })

  it('a growing message REPLACES its previous delta rather than stacking', () => {
    // usage is cumulative within the message: 100 then 150 is 150, not 250.
    recordPolledStats(SESSION, polled())
    recordUsageDelta(SESSION, usage({ output: 100 }))
    const patched = recordUsageDelta(SESSION, usage({ output: 150 }))
    expect(patched?.tokens.output).toBe(200 + 150)
  })

  it('message_end banks the final usage so the NEXT message stacks on it', () => {
    // pi emits one assistant message per tool hop; without banking, hop 2's
    // deltas would erase hop 1 from the totals.
    recordPolledStats(SESSION, polled())
    recordUsageDelta(SESSION, usage({ output: 100 }))
    recordMessageEnd(SESSION, usage({ output: 120, cost: undefined }))
    const patched = recordUsageDelta(SESSION, usage({ output: 30 }))
    expect(patched?.tokens.output).toBe(200 + 120 + 30)
  })

  it('a fresh poll resets the baseline and discards the streaming remainder', () => {
    recordPolledStats(SESSION, polled())
    recordUsageDelta(SESSION, usage({ output: 999 }))
    // The poll's answer already includes whatever was streaming.
    recordPolledStats(
      SESSION,
      polled({
        tokens: { input: 0, output: 400, cacheRead: 0, cacheWrite: 0, total: 400 },
        cost: 0.1,
      }),
    )
    const patched = recordUsageDelta(SESSION, usage({ output: 5 }))
    expect(patched?.tokens.output).toBe(405)
    expect(patched?.cost).toBeCloseTo(0.1)
  })

  it('accumulates cost from message ends and current cost.total', () => {
    recordPolledStats(SESSION, polled({ cost: 0.05 }))
    recordMessageEnd(
      SESSION,
      // recordMessageEnd only banks when a delta has been seen first.
      undefined,
    )
    recordUsageDelta(SESSION, usage({ output: 1 }))
    recordMessageEnd(SESSION, {
      ...usage({ output: 1 }),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    })
    const patched = recordUsageDelta(SESSION, {
      ...usage({ output: 2 }),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
    })
    expect(patched?.cost).toBeCloseTo(0.062)
  })
})

describe('context estimate', () => {
  it("uses pi's own formula: totalTokens wins, else the four-way sum", () => {
    expect(contextTokensOf(usage({ input: 10, output: 5, totalTokens: 99 }))).toBe(99)
    expect(contextTokensOf(usage({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2 }))).toBe(20)
  })

  it('moves the meter from the streaming message against the polled window', () => {
    recordPolledStats(SESSION, polled())
    const patched = recordUsageDelta(SESSION, usage({ input: 100, cacheRead: 19_800, output: 100 }))
    expect(patched?.contextUsage).toEqual({
      tokens: 20_000,
      contextWindow: 200_000,
      percent: 10,
    })
  })

  it('leaves a null post-compaction estimate alone until real usage arrives', () => {
    recordPolledStats(
      SESSION,
      polled({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }),
    )
    // A zero-usage delta (message_start's initial event) proves nothing.
    const early = recordUsageDelta(SESSION, usage({}))
    expect(early?.contextUsage).toEqual({ tokens: null, contextWindow: 200_000, percent: null })
    // Real usage from the streaming message IS fresh post-compaction data.
    const later = recordUsageDelta(SESSION, usage({ input: 5_000 }))
    expect(later?.contextUsage?.tokens).toBe(5_000)
  })

  it('never invents a window the poll did not report', () => {
    recordPolledStats(SESSION, polled({ contextUsage: undefined }))
    const patched = recordUsageDelta(SESSION, usage({ input: 5_000 }))
    expect(patched?.contextUsage).toBeUndefined()
  })
})

/**
 * The OpenAI Responses API (so `openai-codex`: GPT-5.x/GPT-6 on a ChatGPT
 * subscription) fills usage ONLY on its terminal `response.completed` event,
 * so every `message_update` carries a present-but-zeroed usage object. That
 * combination froze the meter for a whole turn: the present field flipped
 * `hasUsageDeltas` on — narrowing the caller's polling to `agent_end` — while
 * the zeroed values gave the overlay nothing to move with.
 *
 * Numbers below are from the real session that surfaced this (2026-09-09,
 * gpt-6-astra, one turn of 95 tool calls) and from an RPC capture of a live
 * codex turn, so a regression reproduces the actual failure rather than a
 * hypothetical one.
 */
describe('a provider that reports usage only at completion', () => {
  const ZEROED = usage({})

  it('still advertises usage deltas, because the field is present', () => {
    recordPolledStats(SESSION, polled())
    recordUsageDelta(SESSION, ZEROED)
    expect(hasUsageDeltas(SESSION)).toBe(true)
  })

  it('takes the estimate from message_end when the deltas say nothing', () => {
    recordPolledStats(
      SESSION,
      polled({ contextUsage: { tokens: 543, contextWindow: 272_000, percent: 0.2 } }),
    )
    // The whole stream: three deltas, none of them carrying a token count.
    for (let i = 0; i < 3; i++) {
      expect(recordUsageDelta(SESSION, ZEROED)?.contextUsage?.tokens).toBe(543)
    }
    // Completion. This is the first and only true reading of the hop.
    const ended = recordMessageEnd(SESSION, usage({ input: 8_472, output: 5, totalTokens: 8_477 }))
    expect(ended?.contextUsage).toEqual({
      tokens: 8_477,
      contextWindow: 272_000,
      percent: (8_477 / 272_000) * 100,
    })
  })

  it('keeps the banked reading across the next hop rather than snapping back', () => {
    recordPolledStats(
      SESSION,
      polled({ contextUsage: { tokens: 543, contextWindow: 272_000, percent: 0.2 } }),
    )
    recordUsageDelta(SESSION, ZEROED)
    recordMessageEnd(SESSION, usage({ totalTokens: 8_477 }))
    // Hop 2 streams: zeroed deltas must not drop the meter to the stale poll.
    expect(recordUsageDelta(SESSION, ZEROED)?.contextUsage?.tokens).toBe(8_477)
    // ...and hop 2's completion advances it again.
    expect(recordMessageEnd(SESSION, usage({ totalTokens: 12_500 }))?.contextUsage?.tokens).toBe(
      12_500,
    )
  })

  it('climbs across a tool-hop turn instead of sitting at the bootstrap poll', () => {
    // Reproduces the reported shape: pi emits one assistant message per hop,
    // and `agent_end` (the only remaining poll) does not fire until the end.
    recordPolledStats(
      SESSION,
      polled({ contextUsage: { tokens: 543, contextWindow: 272_000, percent: 0.2 } }),
    )
    const seen: Array<number | null | undefined> = []
    for (const total of [8_477, 46_741, 92_953, 128_736]) {
      recordUsageDelta(SESSION, ZEROED)
      seen.push(recordMessageEnd(SESSION, usage({ totalTokens: total }))?.contextUsage?.tokens)
    }
    expect(seen).toEqual([8_477, 46_741, 92_953, 128_736])
  })

  it('ignores an aborted message that ended having spent nothing', () => {
    recordPolledStats(
      SESSION,
      polled({ contextUsage: { tokens: 543, contextWindow: 272_000, percent: 0.2 } }),
    )
    recordUsageDelta(SESSION, ZEROED)
    recordMessageEnd(SESSION, usage({ totalTokens: 30_000 }))
    // pi skips zero-usage assistants in its own estimate; so must this.
    expect(recordMessageEnd(SESSION, ZEROED)?.contextUsage?.tokens).toBe(30_000)
  })

  it('yields to the next poll, so a compaction still resets the estimate', () => {
    recordPolledStats(
      SESSION,
      polled({ contextUsage: { tokens: 543, contextWindow: 272_000, percent: 0.2 } }),
    )
    recordUsageDelta(SESSION, ZEROED)
    recordMessageEnd(SESSION, usage({ totalTokens: 260_000 }))
    // `compaction_end` polls, and pi reports null tokens until fresh usage
    // arrives. A pre-compaction reading must not outlive that.
    recordPolledStats(
      SESSION,
      polled({ contextUsage: { tokens: null, contextWindow: 272_000, percent: null } }),
    )
    expect(recordUsageDelta(SESSION, ZEROED)?.contextUsage).toEqual({
      tokens: null,
      contextWindow: 272_000,
      percent: null,
    })
  })

  it('leaves a streaming provider on its own deltas', () => {
    // Anthropic sends input + cache reads on the first frame, so `current`
    // must keep winning — including when it reads LOWER than the last hop,
    // which is what a compaction mid-turn looks like from here.
    recordPolledStats(SESSION, polled())
    recordUsageDelta(SESSION, usage({ input: 100, cacheRead: 19_900 }))
    recordMessageEnd(SESSION, usage({ input: 100, cacheRead: 49_900 }))
    expect(recordUsageDelta(SESSION, usage({ input: 50, cacheRead: 9_950 }))?.contextUsage).toEqual(
      {
        tokens: 10_000,
        contextWindow: 200_000,
        percent: 5,
      },
    )
  })
})

describe('liveBilledTokens', () => {
  it('is session-cumulative and monotonic across message boundaries', () => {
    recordPolledStats(SESSION, polled())
    recordUsageDelta(SESSION, usage({ output: 100 }))
    const during = liveBilledTokens(SESSION)
    recordMessageEnd(SESSION, usage({ output: 100 }))
    const after = liveBilledTokens(SESSION)
    recordUsageDelta(SESSION, usage({ output: 10 }))
    const next = liveBilledTokens(SESSION)
    expect(during).toBe(2000 + 100)
    expect(after).toBe(2000 + 100)
    expect(next).toBe(2000 + 100 + 10)
  })

  it('is null with no baseline, so no burn sample is fabricated', () => {
    expect(liveBilledTokens(SESSION)).toBeNull()
  })
})
