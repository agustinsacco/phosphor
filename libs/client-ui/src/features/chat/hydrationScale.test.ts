// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@shared/rpc'
import { hydrateFromMessages } from './reducer'

/**
 * Hydration runs on the critical path of opening a session, so its cost must
 * scale with transcript LENGTH, not length squared.
 *
 * It used to rebuild `items` (and spread the whole `tools` record) once per
 * message. Measured before/after on a synthetic 16k-item transcript: 648ms →
 * 4ms. The scaling assertion below is what actually guards that; absolute
 * timings are too machine-dependent to assert on.
 */
function transcript(turns: number): AgentMessage[] {
  const messages: unknown[] = []
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `msg ${i}`, timestamp: '2026-01-01' })
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: 'reply '.repeat(20) },
        { type: 'toolCall', id: `call-${i}`, name: 'bash', arguments: { cmd: 'ls' } },
      ],
      timestamp: '2026-01-01',
    })
    messages.push({
      role: 'toolResult',
      toolCallId: `call-${i}`,
      toolName: 'bash',
      content: [{ type: 'text', text: 'x'.repeat(200) }],
    })
  }
  return messages as AgentMessage[]
}

const timeHydration = (turns: number): number => {
  const messages = transcript(turns)
  const start = performance.now()
  hydrateFromMessages(messages)
  return performance.now() - start
}

describe('hydrateFromMessages', () => {
  it('produces one item per user and assistant message, and folds tool results', () => {
    const state = hydrateFromMessages(transcript(3))
    expect(state.items).toHaveLength(6) // 3 user + 3 assistant
    expect(Object.keys(state.tools)).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      const tool = state.tools[`call-${i}`]!
      expect(tool.status).toBe('done')
      // Args survive from the toolCall block; the result is folded in after.
      expect(tool.args).toEqual({ cmd: 'ls' })
      expect(tool.result?.content).toEqual([{ type: 'text', text: 'x'.repeat(200) }])
    }
  })

  it('shares one payload object between `result` and `output`', () => {
    // Both fields are part of the contract (final vs latest-partial), but a
    // tool payload can be hundreds of KB — storing two structurally-equal
    // copies doubled retained memory for every completed tool.
    const tool = hydrateFromMessages(transcript(1)).tools['call-0']!
    expect(tool.result).toBe(tool.output)
  })

  /*
   * The two assertions below are wall-clock measurements taken inside a
   * parallel test suite, so they compete with whatever else vitest is running
   * in another worker. `retry` rather than a looser threshold: the numbers are
   * chosen to separate linear from quadratic, and widening them to absorb load
   * noise would blunt exactly that. A real O(n^2) fails all three attempts;
   * contention does not.
   *
   * Observed: adding one unrelated test file to the suite was enough to push
   * the ratio to 26.5 on a developer machine — noise, not a regression (a
   * quadratic form measures ~64x), but over the threshold all the same.
   */
  it('scales linearly, not quadratically, with transcript length', { retry: 2 }, () => {
    // Warm up so JIT compilation is not attributed to the small sample.
    timeHydration(200)

    const small = Math.max(timeHydration(500), 0.05)
    const large = Math.max(timeHydration(4_000), 0.05)

    // 8x the input. Linear predicts ~8x; the previous quadratic form was ~64x.
    // 24x leaves generous headroom for GC noise on a loaded CI box while still
    // failing loudly on a reintroduced O(n^2).
    expect(large / small).toBeLessThan(24)
  })

  it('stays fast enough to open a very long session without a visible stall', { retry: 2 }, () => {
    // 8k turns ≈ 16k items. The quadratic version took ~650ms here.
    expect(timeHydration(8_000)).toBeLessThan(400)
  })
})
