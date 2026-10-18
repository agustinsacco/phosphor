import { describe, expect, it } from 'vitest'
import { measureMessages, type LedgerEntry, type MessageLedger } from './message-ledger'

const textEntry = (role: string, chars: number): LedgerEntry => ({
  type: 'message',
  message: { role, content: [{ type: 'text', text: 'x'.repeat(chars) }] },
})
const reply = (
  input: number,
  output: number,
  options: { model?: string; totalTokens?: number; timestamp?: string } = {},
): LedgerEntry => ({
  ...textEntry('assistant', 40),
  timestamp: options.timestamp,
  message: {
    ...textEntry('assistant', 40).message,
    model: options.model ?? 'm',
    provider: 'p',
    stopReason: 'toolUse',
    usage: { input, output, totalTokens: options.totalTokens ?? input + output },
  },
})
const ledger = (
  tokens: number,
  thinking: number,
  count: number,
  measuredCalls: number,
  calls: number,
  charsPerToken = 4,
): MessageLedger => ({ tokens, thinking, count, charsPerToken, measuredCalls, calls })

const corpus: { name: string; entries: LedgerEntry[]; expected: MessageLedger }[] = [
  {
    name: 'falls back to character estimates without usage',
    entries: [
      { type: 'compaction', summary: 'x'.repeat(7) },
      textEntry('user', 10),
      textEntry('toolResult', 4),
    ],
    expected: ledger(6, 0, 2, 0, 0),
  },
  {
    name: 'uses the image stand-in without usage',
    entries: [
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'hello' }] },
      },
    ],
    expected: ledger(1202, 0, 1, 0, 0),
  },
  {
    name: 'discards measured reasoning before a model switch',
    entries: [
      reply(1000, 100),
      textEntry('toolResult', 400),
      reply(1200, 100),
      textEntry('toolResult', 400),
      reply(1400, 100, { model: 'other' }),
    ],
    expected: ledger(230, 90, 5, 0, 3),
  },
  {
    name: 'keeps the anchor on an exact 20 percent input drop',
    entries: [reply(1000, 100), textEntry('toolResult', 400), reply(800, 100)],
    expected: ledger(120, 90, 3, 0, 2),
  },
  {
    name: 'rebuilds after a greater than 20 percent input drop',
    entries: [
      reply(1000, 100),
      textEntry('toolResult', 400),
      reply(1200, 100),
      textEntry('toolResult', 400),
      reply(959, 100),
    ],
    expected: ledger(230, 90, 5, 0, 3),
  },
  {
    name: 'cuts usage older than the leading compaction timestamp',
    entries: [
      { type: 'compaction', summary: 'x'.repeat(400), timestamp: '2026-01-02' },
      reply(10000, 1000, { timestamp: '2026-01-01' }),
      textEntry('toolResult', 400),
      reply(11100, 100, { timestamp: '2026-01-02' }),
    ],
    expected: ledger(220, 90, 3, 0, 2),
  },
  {
    name: 'estimates everything when all calls predate compaction',
    entries: [
      { type: 'compaction', summary: 'x'.repeat(400), timestamp: '2026-01-02' },
      reply(10000, 1000, { timestamp: '2026-01-01' }),
      textEntry('toolResult', 400),
    ],
    expected: ledger(210, 0, 2, 0, 1),
  },
  {
    name: 'omits the final output when totalTokens omits it',
    entries: [textEntry('user', 5), reply(1000, 100, { totalTokens: 1000 })],
    expected: ledger(2, 0, 2, 0, 1),
  },
  {
    name: 'rejects negative pair remainders without a rebuild',
    entries: [reply(1000, 100), textEntry('toolResult', 400), reply(1050, 100)],
    expected: ledger(120, 90, 3, 0, 2),
  },
  {
    name: 'rejects an implausible input spike',
    entries: [reply(1000, 100), textEntry('toolResult', 400), reply(10000, 100)],
    expected: ledger(120, 90, 3, 0, 2),
  },
  {
    name: 'ignores aborted, errored and non-finite usage calls',
    entries: [
      { type: 'message', message: { ...reply(1000, 100).message, stopReason: 'aborted' } },
      { type: 'message', message: { ...reply(1000, 100).message, stopReason: 'error' } },
      reply(Number.NaN, Number.POSITIVE_INFINITY),
      textEntry('user', 5),
    ],
    expected: ledger(32, 0, 4, 0, 0),
  },
]

const calibratedEntries: LedgerEntry[] = [textEntry('user', 2001)]
for (let k = 0; k < 4; k++) {
  calibratedEntries.push(reply(10000 + k * 1100, 100), textEntry('toolResult', 2000))
}
calibratedEntries.push(reply(14400, 100))
corpus.push({
  name: 'preserves calibrated provider pair accumulation and final reply',
  entries: calibratedEntries,
  expected: ledger(5101, 400, 10, 4, 5, 2),
})

describe('measureMessages frozen provider and compaction corpus', () => {
  it.each(corpus)('$name', ({ entries, expected }) => {
    expect(measureMessages(entries)).toEqual(expected)
  })
})
