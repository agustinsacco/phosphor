import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '@phosphor/memory-engine/types'
import { verifyQuotes } from './quotes'
import { RAW_EXTRACTION } from './__fixtures__/lane'

const segment = (text: string, entryId = 'user'): TranscriptSegment => ({
  entryId,
  role: 'user',
  label: 'You · Nov 6, 12:47',
  observedAt: 1,
  text,
})
function verify(text: string, quotes: string[], summary = 'Rina Okafor owns Harbor billing.') {
  return verifyQuotes(
    { ...RAW_EXTRACTION, memories: [{ ...RAW_EXTRACTION.memories[0]!, quotes, summary }] },
    [segment(text)],
  )
}

describe('verifyQuotes', () => {
  it('matches exact, whitespace-tolerant, then folded case, Unicode quotes and dashes', () => {
    expect(
      verify('Rina owns Harbor.', ['Rina owns Harbor.']).memories[0]!.citations[0]!.quote,
    ).toBe('Rina owns Harbor.')
    expect(
      verify('Rina\n  owns\tHarbor.', ['Rina owns Harbor.']).memories[0]!.citations[0]!.quote,
    ).toBe('Rina\n  owns\tHarbor.')
    expect(
      verify('Ｒｉｎａ says “Harbor”—billing.', ['rina says "harbor"-billing.']).memories[0]!
        .citations[0]!.quote,
    ).toBe('Ｒｉｎａ says “Harbor”—billing.')
  })

  it('normalises composed graphemes while preserving original quote offsets', () => {
    expect(
      verify('Harbor café policy.', ['HARBOR cafe\u0301 policy.']).memories[0]!.citations[0]!.quote,
    ).toBe('Harbor café policy.')
  })

  it('prefers an exact match across segments over an earlier normalised match', () => {
    const result = verifyQuotes(RAW_EXTRACTION, [
      segment('RINA OKAFOR OWNS HARBOR BILLING.', 'first'),
      segment(RAW_EXTRACTION.memories[0]!.quotes[0]!, 'second'),
    ])
    expect(result.evidence[0]!.entryId).toBe('second')
  })

  it('drops unmatched quotes and memories with no verified quote, with a reason', () => {
    const raw = structuredClone(RAW_EXTRACTION)
    raw.memories.push({
      ...raw.memories[0]!,
      summary: 'Tom Lee owns Harbor.',
      quotes: ['Tom Lee owns Harbor.'],
    })
    raw.memories[0]!.quotes.push('This did not happen.')
    const result = verifyQuotes(raw, [segment('Rina Okafor owns Harbor billing.')])
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0]!.citations).toHaveLength(1)
    expect(result.dropped).toEqual(['No verified quote: Tom Lee owns Harbor.'])
  })

  it('merges overlapping windows and keeps one union excerpt per segment across memories', () => {
    const text =
      'x'.repeat(500) +
      'Rina owns Harbor.' +
      'z'.repeat(100) +
      'Tom Lee reviews it.' +
      'y'.repeat(900)
    const result = verify(text, ['Rina owns Harbor.', 'Tom Lee reviews it.'])
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]!.text).toBe(
      `…${text.slice(100, text.indexOf('Tom Lee reviews it.') + 'Tom Lee reviews it.'.length + 400)}…`,
    )
    expect(result.memories[0]!.citations.map((c) => c.evidence)).toEqual([0, 0])
    const separated = verifyQuotes(
      {
        ...RAW_EXTRACTION,
        memories: [{ ...RAW_EXTRACTION.memories[0]!, quotes: ['Rina', 'Tom'] }],
      },
      [segment('before Rina' + ' '.repeat(1000) + 'Tom after')],
      { window: 4 },
    )
    expect(separated.evidence[0]!.text).toBe('…ore Rina    …    Tom aft…')
  })

  it('scrubs secrets from summaries, literal values, evidence and citation text', () => {
    const secrets = [
      'sk-FAKEHarborKey12345',
      'ghp_FAKEHarborToken12345',
      'xoxb-FAKEHarborToken-12345',
      'AKIA1234567890ABCDEF',
      'Bearer FAKE-Harbor-credential',
      'eyJhbGciOiJIUzI1NiJ9.e30.signature',
      'password=harbor-secret',
      'token="harbor secret"',
      'https://rina:secret@harbor.test/api',
      'rina@harbor.test',
      '-----BEGIN PRIVATE KEY-----\nFAKE PRIVATE KEY MATERIAL\n-----END PRIVATE KEY-----',
    ]
    for (const secret of secrets) {
      const result = verify(
        `Harbor uses ${secret}.`,
        [`Harbor uses ${secret}.`],
        `Harbor uses ${secret}.`,
      )
      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain(secret.replace(/\n/g, '\\n'))
      expect(result.memories[0]!.summary).toContain('[redacted]')
      expect(result.memories[0]!.citations[0]!.quote).toContain('[redacted]')
      expect(result.evidence[0]!.text).toContain('[redacted]')
    }
  })

  it('redacts a private key even when the excerpt window cuts inside its body', () => {
    const text =
      '-----BEGIN PRIVATE KEY-----\n' +
      'FAKEKEY'.repeat(200) +
      '\n-----END PRIVATE KEY-----\nHarbor billing.'
    const result = verify(text, ['Harbor billing.'])
    expect(result.evidence[0]!.text).toBe('…[redacted]\nHarbor billing.')
    expect(verify('abc', ['']).memories).toEqual([])
  })
})
