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
  const wanted = folded(quote.trim()).text
  for (let i = 0; i < spans.length; i++)
    for (const span of spans[i]!) {
      const source = folded(span)
      const at = source.text.indexOf(wanted)
      if (at >= 0)
        return {
          segment: `s${i + 1}`,
          quote: span.slice(source.offsets[at], source.offsets[at + wanted.length - 1]! + 1),
        }
    }
  throw new Error(`Quote not found in ${segment}: ${quote.slice(0, 100)}`)
}

/**
 * One space per whitespace run and straight quotation marks, with the source offset of every
 * folded character. A plain search over this is linear; a pattern built from the quote was not.
 */
function folded(text: string): { text: string; offsets: number[] } {
  const out: string[] = [],
    offsets: number[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    const space = /\s/.test(char)
    if (space && out.at(-1) === ' ') continue
    out.push(space ? ' ' : '“”'.includes(char) ? '"' : '‘’'.includes(char) ? "'" : char)
    offsets.push(i)
  }
  return { text: out.join(''), offsets }
}
