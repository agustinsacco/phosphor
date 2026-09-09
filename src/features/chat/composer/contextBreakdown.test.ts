import { describe, expect, it } from 'vitest'
import { breakdownSlices, mcpServerRows, parseContextBreakdown } from './contextBreakdown'

/** Shape captured live from the bundled extension via pi's status channel. */
const LIVE = JSON.stringify({
  totalTokens: null,
  contextWindow: null,
  parts: { messages: 0, systemPrompt: 728, tools: 638, mcpTools: 0 },
  counts: { tools: 4, mcpTools: 0, messages: 0 },
  approximate: true,
})

describe('parseContextBreakdown', () => {
  it('parses the live payload', () => {
    const parsed = parseContextBreakdown(LIVE)
    expect(parsed?.parts).toEqual({ messages: 0, systemPrompt: 728, tools: 638, mcpTools: 0 })
    expect(parsed?.counts.tools).toBe(4)
    expect(parsed?.approximate).toBe(true)
  })

  it('degrades to null rather than throwing on untrusted input', () => {
    // A status string comes from a subprocess; a bad one must not break the meter.
    expect(parseContextBreakdown(undefined)).toBeNull()
    expect(parseContextBreakdown('not json')).toBeNull()
    expect(parseContextBreakdown('{}')).toBeNull()
    expect(parseContextBreakdown('{"parts":"nope"}')).toBeNull()
  })

  it('clamps nonsense numbers instead of trusting them', () => {
    const parsed = parseContextBreakdown(
      '{"parts":{"messages":-5,"systemPrompt":"x","tools":10,"mcpTools":null}}',
    )
    expect(parsed?.parts).toEqual({ messages: 0, systemPrompt: 0, tools: 10, mcpTools: 0 })
  })

  it('treats a payload with no per-server detail as no detail, not zero cost', () => {
    // A session started by an older Phosphor build sends no mcpByServer key.
    expect(parseContextBreakdown(LIVE)?.mcpByServer).toEqual({})
    expect(
      parseContextBreakdown('{"parts":{"messages":1},"mcpByServer":"nope"}')?.mcpByServer,
    ).toEqual({})
  })
})

describe('mcpServerRows', () => {
  const breakdown = parseContextBreakdown(
    JSON.stringify({
      parts: { messages: 100, systemPrompt: 100, tools: 100, mcpTools: 200 },
      counts: { tools: 4, mcpTools: 30, messages: 2 },
      mcpByServer: {
        linear: { tokens: 50, count: 8 },
        datadog: { tokens: 150, count: 22 },
        empty: { tokens: 0, count: 0 },
      },
    }),
  )!

  it('orders by cost and keeps its own estimate when pi counts more', () => {
    // Measured 500, pi says 1000. The extra 500 belongs to the provider, not
    // to these servers, so the rows report what they measured.
    expect(mcpServerRows(breakdown, 1000)).toEqual([
      { name: 'datadog', tokens: 150, count: 22 },
      { name: 'linear', tokens: 50, count: 8 },
    ])
  })

  it('scales down when the estimate overshoots pi', () => {
    // Measured 500, pi says 250: chars/4 overshot, so halve.
    expect(mcpServerRows(breakdown, 250)).toEqual([
      { name: 'datadog', tokens: 75, count: 22 },
      { name: 'linear', tokens: 25, count: 8 },
    ])
  })

  it('has nothing to say when no server reported', () => {
    expect(mcpServerRows(parseContextBreakdown(LIVE)!, 1000)).toEqual([])
  })
})

describe('breakdownSlices', () => {
  const breakdown = parseContextBreakdown(
    JSON.stringify({
      parts: { messages: 300, systemPrompt: 100, tools: 100, mcpTools: 0 },
      counts: { tools: 4, mcpTools: 0, messages: 12 },
      approximate: true,
    }),
  )!

  it('keeps measured components at their measured size', () => {
    const byKey = Object.fromEntries(
      breakdownSlices(breakdown, 1000, 10_000).map((s) => [s.key, s.tokens]),
    )
    expect(byKey.messages).toBe(300)
    expect(byKey.systemPrompt).toBe(100)
    expect(byKey.tools).toBe(100)
  })

  it("reports pi's unattributed remainder as its own slice", () => {
    const slices = breakdownSlices(breakdown, 1000, 10_000)
    const unmeasured = slices.find((s) => s.key === 'unmeasured')
    expect(unmeasured?.tokens).toBe(500)
    expect(unmeasured?.hint).toContain('not visible from inside it')
  })

  /**
   * The regression this file exists for. The old code scaled estimates UP to
   * pi's total, so a Claude session's hidden CLI prompt landed on our slices:
   * one fixed 9,914-token system prompt rendered as 44.1k then 22.5k as the
   * provider's share moved. Measured 2026-09-09 on session 01a0865a.
   */
  it('holds a fixed system prompt steady while the provider share swings', () => {
    const claude = parseContextBreakdown(
      JSON.stringify({
        parts: { messages: 1259, systemPrompt: 9914, tools: 7868, mcpTools: 698 },
        counts: { tools: 27, mcpTools: 5, messages: 4 },
      }),
    )!
    for (const total of [87_880, 50_461, 56_054, 63_576]) {
      const slices = breakdownSlices(claude, total, 1_000_000)
      expect(slices.find((s) => s.key === 'systemPrompt')?.tokens).toBe(9914)
      // Nothing is invented and nothing is lost: the legend sums to pi's total.
      const used = slices.filter((s) => s.key !== 'free').reduce((n, s) => n + s.tokens, 0)
      expect(used).toBe(total)
    }
  })

  it('scales down, never up, when the estimate overshoots pi', () => {
    // Measured 500 against a real 250 — a component cannot outweigh the request.
    const byKey = Object.fromEntries(
      breakdownSlices(breakdown, 250, 10_000).map((s) => [s.key, s.tokens]),
    )
    expect(byKey.messages).toBe(150)
    expect(byKey.systemPrompt).toBe(50)
    expect(byKey.unmeasured).toBeUndefined()
  })

  it('always ends with free space as the honest remainder', () => {
    const slices = breakdownSlices(breakdown, 1000, 10_000)
    const free = slices[slices.length - 1]!
    expect(free.key).toBe('free')
    expect(free.tokens).toBe(9000)
    expect(free.percent).toBeCloseTo(90, 5)
  })

  it('omits empty components and survives a zero total', () => {
    const slices = breakdownSlices(breakdown, 0, 10_000)
    expect(slices.map((s) => s.key)).toEqual(['free'])
    expect(slices.some((s) => s.key === 'mcpTools')).toBe(false)
  })
})
