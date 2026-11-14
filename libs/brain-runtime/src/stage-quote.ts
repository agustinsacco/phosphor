import type { StageQuote } from './stage-types'
import type { TranscriptWindow } from './windows'
import { ELISION } from './constants'

/** Flexible matches return the source substring, never a normalized replacement. */
export function verifiedQuote(value: unknown, window: TranscriptWindow): StageQuote {
  if (!value || typeof value !== 'object') throw new Error('Expected a quote object')
  const { quote, segment } = value as { quote?: unknown; segment?: unknown }
  if (typeof quote !== 'string' || !quote.trim()) throw new Error('Expected nonempty quote')
  if (typeof segment !== 'string' || !/^s[1-9]\d*$/.test(segment))
    throw new Error('Invalid segment ref')
  if (ELISION.test(quote)) throw new Error('A quote cannot contain an elision marker')
  const spans = window.segments.map((s) => s.text.split(ELISION))
  const cited = Number(segment.slice(1)) - 1
  if (spans[cited]?.some((span) => span.includes(quote))) return { segment, quote }
  const exact = spans.findIndex((parts) => parts.some((span) => span.includes(quote)))
  if (exact >= 0) return { segment: `s${exact + 1}`, quote }
  const pattern = new RegExp(
    quote
      .split(/(\s+)/)
      .map((part) => {
        if (/^\s+$/.test(part)) return '\\s+'
        return part
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/["“”]/g, '["“”]')
          .replace(/['‘’]/g, "['‘’]")
      })
      .join(''),
  )
  for (let i = 0; i < spans.length; i++)
    for (const span of spans[i]!) {
      const match = pattern.exec(span)
      if (match) return { segment: `s${i + 1}`, quote: match[0] }
    }
  throw new Error(`Quote not found in ${segment}: ${quote.slice(0, 100)}`)
}
