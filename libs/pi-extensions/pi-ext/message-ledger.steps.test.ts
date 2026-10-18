import { describe, expect, it } from 'vitest'
import {
  accumulateLedger,
  entryChars,
  measuredPairs,
  measuredRatio,
  rebuildAnchor,
  splitReply,
  type LedgerEntry,
} from './message-ledger'

const reply = (
  input: number,
  output: number,
  options: { model?: string; provider?: string; timestamp?: string } = {},
): LedgerEntry => ({
  type: 'message',
  timestamp: options.timestamp,
  message: {
    role: 'assistant',
    model: options.model ?? 'm',
    provider: options.provider ?? 'p',
    content: [{ type: 'text', text: 'x'.repeat(40) }],
    usage: { input, output, totalTokens: input + output },
  },
})
const result: LedgerEntry = {
  type: 'message',
  message: { role: 'toolResult', content: 'x'.repeat(400) },
}
const pairWithRatio = (ratio: number) => ({
  output: 100,
  rest: 2000 / ratio,
  restChars: 2000,
  plainText: true,
})

function pairsFor(entries: readonly LedgerEntry[], calls: readonly number[]) {
  return measuredPairs(entries, entries.map(entryChars), calls)
}

describe('measuredPairs', () => {
  it('measures the range strictly between consecutive calls, in call order', () => {
    const entries: readonly LedgerEntry[] = [
      reply(1000, 100),
      result,
      reply(1200, 200),
      reply(1400, 10),
    ]
    expect(pairsFor(entries, [0, 2, 3])).toEqual([
      { output: 100, rest: 100, restChars: 400, plainText: true },
      { output: 200, rest: 0, restChars: 0, plainText: true },
    ])
  })

  it.each([
    { rest: -1, accepted: false },
    { rest: 0, accepted: true },
    { rest: 1400, accepted: true },
    { rest: 1401, accepted: false },
  ])('uses per-entry framing slack at remainder $rest', ({ rest, accepted }) => {
    const pairs = pairsFor([reply(1000, 100), result, reply(1100 + rest, 10)], [0, 2])
    expect(pairs[0]).toEqual(
      accepted ? { output: 100, rest, restChars: 400, plainText: true } : null,
    )
  })

  it.each([{ model: 'other' }, { provider: 'other' }])(
    'rejects a changed identity %j',
    (options) => {
      expect(pairsFor([reply(1000, 100), result, reply(1200, 10, options)], [0, 2])).toEqual([null])
    },
  )

  it('includes input caches in the request difference', () => {
    const entries: readonly LedgerEntry[] = [
      {
        ...reply(1000, 100),
        message: {
          ...reply(1000, 100).message,
          usage: { input: 1000, cacheRead: 200, output: 100 },
        },
      },
      result,
      {
        ...reply(1000, 10),
        message: {
          ...reply(1000, 10).message,
          usage: { input: 1000, cacheRead: 300, cacheWrite: 100, output: 10 },
        },
      },
    ]
    expect(pairsFor(entries, [0, 2])).toEqual([
      { output: 100, rest: 100, restChars: 400, plainText: true },
    ])
  })

  it.each(['message', 'custom_message'])('marks intervening %s images as non-text', (type) => {
    const content = [{ type: 'image' }]
    const image: LedgerEntry = { type, content, message: { role: 'user', content } }
    expect(pairsFor([reply(1000, 100), image, reply(1200, 10)], [0, 2])).toEqual([
      { output: 100, rest: 100, restChars: 4800, plainText: false },
    ])
  })

  it('has no pair with fewer than two calls', () => {
    expect(pairsFor([], [])).toEqual([])
    expect(pairsFor([reply(1000, 100)], [0])).toEqual([])
  })
})

describe('measuredRatio', () => {
  it('requires at least three eligible samples', () => {
    expect(measuredRatio([pairWithRatio(2), pairWithRatio(2)])).toBe(4)
    expect(measuredRatio([pairWithRatio(2), pairWithRatio(3), pairWithRatio(1)])).toBe(2)
  })

  it('excludes null, image, short and zero-token pairs', () => {
    expect(
      measuredRatio([
        pairWithRatio(2),
        pairWithRatio(2),
        null,
        { ...pairWithRatio(2), plainText: false },
        { ...pairWithRatio(2), restChars: 999 },
        { ...pairWithRatio(2), rest: 0 },
      ]),
    ).toBe(4)
  })

  it('includes exactly 1000 characters and averages the middle two sorted samples', () => {
    const pairs = [pairWithRatio(4), pairWithRatio(1), pairWithRatio(3), pairWithRatio(2)]
    pairs[0] = { ...pairs[0]!, restChars: 1000, rest: 250 }
    expect(measuredRatio(pairs)).toBe(2.5)
    expect(pairs.map((pair) => pair.restChars / pair.rest)).toEqual([4, 1, 3, 2])
  })

  it.each([
    { ratio: 0.5, expected: 1 },
    { ratio: 5, expected: 4 },
  ])('clamps median $ratio to $expected', ({ ratio, expected }) => {
    expect(measuredRatio(Array.from({ length: 3 }, () => pairWithRatio(ratio)))).toBe(expected)
  })
})

describe('rebuildAnchor', () => {
  it.each([
    { input: 800, expected: 0 },
    { input: 799, expected: 1 },
  ])('uses a strict greater-than-20-percent drop for input $input', ({ input, expected }) => {
    expect(rebuildAnchor([reply(1000, 100), reply(input, 100)], [0, 1])).toBe(expected)
  })

  it('selects the latest model or provider rebuild', () => {
    const entries = [
      reply(1000, 100),
      reply(1200, 100, { model: 'other' }),
      reply(1400, 100, { model: 'other', provider: 'other' }),
    ]
    expect(rebuildAnchor(entries, [0, 1, 2])).toBe(2)
  })

  it('skips old compaction usage but accepts equal and missing timestamps', () => {
    const entries: readonly LedgerEntry[] = [
      { type: 'compaction', timestamp: '2026-01-02' },
      reply(1000, 100, { timestamp: '2026-01-01' }),
      reply(1200, 100, { timestamp: '2026-01-02' }),
      reply(1400, 100),
    ]
    expect(rebuildAnchor(entries, [1, 2, 3])).toBe(1)
    expect(rebuildAnchor(entries.slice(0, 2), [1])).toBe(1)
  })

  it('does not use a compaction timestamp unless it leads the entries', () => {
    expect(
      rebuildAnchor(
        [
          result,
          { type: 'compaction', timestamp: '2026-01-02' },
          reply(1000, 100, { timestamp: '2026-01-01' }),
        ],
        [2],
      ),
    ).toBe(0)
    expect(rebuildAnchor([], [])).toBe(0)
  })
})

describe('splitReply', () => {
  it('estimates visible text and tool calls, not thinking summaries', () => {
    const entry: LedgerEntry = {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'thinking', thinking: 'x'.repeat(1000) },
          { type: 'toolCall', name: 'read', arguments: { path: 'a' } },
        ],
      },
    }
    // 5 text + 4 tool name + 12 serialized argument characters, rounded up.
    expect(splitReply(entry, 100, 4)).toEqual({ visible: 6, hidden: 94 })
    expect(splitReply(entry, 100, 2)).toEqual({ visible: 11, hidden: 89 })
  })

  it.each([0, 5, -5])('caps visible tokens at the supplied reply size %s', (size) => {
    expect(splitReply(reply(1000, 100), size, 4)).toEqual({ visible: size, hidden: 0 })
  })
})

describe('accumulateLedger', () => {
  it('estimates the entire range once if no calls remain after the anchor', () => {
    expect(accumulateLedger([result, result], [5, 5], [], [], 0, 4)).toEqual({
      tokens: 3,
      thinking: 0,
      measuredCalls: 0,
    })
  })

  it('accumulates measured, fallback and final reply ranges with trailing entries', () => {
    const entries: readonly LedgerEntry[] = [
      result,
      reply(1000, 100),
      result,
      reply(1200, 100),
      result,
      reply(1250, 100),
      result,
    ]
    expect(
      accumulateLedger(
        entries,
        entries.map(entryChars),
        [1, 3, 5],
        pairsFor(entries, [1, 3, 5]),
        0,
        4,
      ),
    ).toEqual({ tokens: 430, thinking: 180, measuredCalls: 1 })
  })
})
