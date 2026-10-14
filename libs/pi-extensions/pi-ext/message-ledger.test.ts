import { describe, expect, it } from 'vitest'
import { measureMessages, type LedgerEntry } from './message-ledger'

const user = (text: string): LedgerEntry => ({
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const result = (text: string): LedgerEntry => ({
  type: 'message',
  message: { role: 'toolResult', content: [{ type: 'text', text }] },
})
/** A reply whose request held `input` tokens and which generated `output`. */
const reply = (
  input: number,
  output: number,
  opts: { text?: string; summary?: string; model?: string; totalTokens?: number } = {},
): LedgerEntry => ({
  type: 'message',
  message: {
    role: 'assistant',
    model: opts.model ?? 'm',
    provider: 'p',
    stopReason: 'toolUse',
    content: [
      { type: 'thinking', thinking: opts.summary ?? '' },
      { type: 'text', text: opts.text ?? '' },
    ],
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: opts.totalTokens ?? input },
  },
})

describe('measureMessages (ledger)', () => {
  it("is pi's 4-chars estimate when no reply has usage", () => {
    const entries: LedgerEntry[] = [
      { type: 'compaction', summary: 'x'.repeat(40) },
      user('y'.repeat(40)),
      result('z'.repeat(40)),
    ]
    expect(measureMessages(entries)).toMatchObject({ tokens: 30, thinking: 0, count: 2 })
  })

  it('measures hidden thinking and real tool-result size from consecutive usage', () => {
    // Reply 1 generated 1,000 tokens but shows 40 chars (10 tokens): 990 are
    // reasoning. The next request grew by 1,000 + 600, so the 1,200-char tool
    // result really cost 600 tokens (2 chars/token), not 300.
    const entries: LedgerEntry[] = [
      user('u'.repeat(400)),
      reply(5_000, 1_000, { text: 't'.repeat(40), summary: 's'.repeat(200) }),
      result('r'.repeat(1_200)),
      reply(6_600, 50),
    ]
    const ledger = measureMessages(entries)
    expect(ledger.thinking).toBe(990)
    // 400 chars of user before the first call (4 chars/token: too few samples
    // to calibrate), 10 visible + 600 exact, and the last reply adds nothing
    // because its totalTokens leaves its output out.
    expect(ledger.tokens).toBe(100 + 10 + 600)
    expect(ledger.measuredCalls).toBe(1)
  })

  it('counts the last reply when its usage total includes the output', () => {
    const entries: LedgerEntry[] = [
      user('u'),
      reply(1_000, 300, { text: 't'.repeat(80), totalTokens: 1_300 }),
    ]
    expect(measureMessages(entries)).toMatchObject({ thinking: 280, tokens: 1 + 20 })
  })

  it('falls back to the estimate when a pair does not add up', () => {
    // Input grew by less than the reply: it was not kept whole.
    const entries: LedgerEntry[] = [
      reply(5_000, 1_000, { text: 't'.repeat(40) }),
      result('r'.repeat(400)),
      reply(5_200, 10),
    ]
    const ledger = measureMessages(entries)
    expect(ledger.thinking).toBe(0)
    expect(ledger.tokens).toBe(Math.ceil((40 + 400) / 4))
  })

  it('rejects a cache-miss spike that the entries could not hold', () => {
    const entries: LedgerEntry[] = [
      reply(5_000, 100, { text: 't'.repeat(40) }),
      result('r'.repeat(40)),
      reply(200_000, 10),
    ]
    expect(measureMessages(entries)).toMatchObject({ thinking: 0, measuredCalls: 0 })
  })

  it('measures only since the last rebuild, where history was replayed', () => {
    // The input fell from 50k to 20k: the provider rebuilt the request, so the
    // thinking measured before that point is no longer in the window.
    const entries: LedgerEntry[] = [
      reply(40_000, 5_000, { text: 't'.repeat(40) }),
      result('r'.repeat(40)),
      reply(45_020, 5_000, { text: 't'.repeat(40) }),
      result('r'.repeat(40)),
      reply(20_000, 2_000, { text: 't'.repeat(40) }),
      result('r'.repeat(400)),
      reply(22_100, 10),
    ]
    const ledger = measureMessages(entries)
    expect(ledger.thinking).toBe(2_000 - 10)
    expect(ledger.measuredCalls).toBe(1)
  })

  it('treats a model switch as a rebuild', () => {
    const entries: LedgerEntry[] = [
      reply(5_000, 1_000, { text: 't'.repeat(40) }),
      result('r'.repeat(40)),
      reply(6_100, 10, { model: 'other' }),
    ]
    expect(measureMessages(entries)).toMatchObject({ thinking: 0, measuredCalls: 0 })
  })

  it("calibrates the estimate's ratio from measured pairs", () => {
    const entries: LedgerEntry[] = [user('u'.repeat(2_000))]
    let input = 10_000
    for (let i = 0; i < 4; i++) {
      entries.push(reply(input, 100), result('r'.repeat(2_000)))
      input += 100 + 1_000 // 2,000 chars cost 1,000 tokens: 2 chars/token
    }
    entries.push(reply(input, 10))
    const ledger = measureMessages(entries)
    expect(ledger.charsPerToken).toBe(2)
    // The 2,000-char user message before the first call uses that ratio.
    expect(ledger.tokens).toBe(1_000 + 4 * 1_000)
  })

  it('skips the compacted-away usage of kept entries', () => {
    // Kept replies predate the compaction; their usage measured the old,
    // larger request, not the one the model holds now.
    const entries: LedgerEntry[] = [
      { type: 'compaction', summary: 's'.repeat(400), timestamp: '2026-01-02' },
      { ...reply(300_000, 5_000, { text: 't'.repeat(40) }), timestamp: '2026-01-01' },
      result('r'.repeat(40)),
      { ...user('u'.repeat(40)), timestamp: '2026-01-03' },
    ]
    const ledger = measureMessages(entries)
    expect(ledger.thinking).toBe(0)
    expect(ledger.tokens).toBe(Math.ceil((400 + 40 + 40 + 40) / 4))
  })
})
