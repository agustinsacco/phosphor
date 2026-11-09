import type {
  EvidenceExcerpt,
  Extraction,
  RawExtraction,
  TranscriptSegment,
} from '@phosphor/memory-engine/types'
import { scrubExcerpt } from './secrets'

interface Match {
  segment: number
  start: number
  end: number
}
interface Window {
  start: number
  end: number
}
export interface QuoteOptions {
  onVerified?: (index: number, kept: boolean) => void
  window?: number
}
export interface VerifiedQuotes {
  memories: Extraction['memories']
  evidence: EvidenceExcerpt[]
  dropped: string[]
}

function normalise(char: string): string {
  return char
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
}

/** Keep offsets into the original, including NFKC expansions and collapsed whitespace. */
function indexed(
  text: string,
  normalised: boolean,
): { text: string; starts: number[]; ends: number[] } {
  const out: string[] = []
  let whitespace = false
  const starts: number[] = []
  const ends: number[] = []
  const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)
  for (const { segment: char, index: offset } of graphemes) {
    const value = normalised ? normalise(char) : char
    for (const c of value) {
      if (/\s/u.test(c)) {
        if (whitespace) {
          ends[ends.length - 1] = offset + char.length
          continue
        }
        out.push(' ')
        whitespace = true
      } else {
        out.push(c)
        whitespace = false
      }
      for (let i = 0; i < c.length; i++) {
        starts.push(offset)
        ends.push(offset + char.length)
      }
    }
  }
  return { text: out.join(''), starts, ends }
}

function findQuote(
  quote: string,
  segments: TranscriptSegment[],
  cache: Map<string, ReturnType<typeof indexed>>,
): Match | undefined {
  for (const mode of ['exact', 'whitespace', 'normalised'] as const) {
    for (let segment = 0; segment < segments.length; segment++) {
      const text = segments[segment]!.text
      if (mode === 'exact') {
        const start = text.indexOf(quote)
        if (start >= 0) return { segment, start, end: start + quote.length }
      } else {
        const key = `${segment}:${mode}`
        let source = cache.get(key)
        if (!source) {
          source = indexed(text, mode === 'normalised')
          cache.set(key, source)
        }
        const needle = indexed(quote, mode === 'normalised').text.trim()
        if (!needle) continue
        const at = source.text.indexOf(needle)
        if (at >= 0)
          return { segment, start: source.starts[at]!, end: source.ends[at + needle.length - 1]! }
      }
    }
  }
  return undefined
}

function excerpt(segment: TranscriptSegment, matches: Match[], radius: number): EvidenceExcerpt {
  const windows: Window[] = []
  for (const match of matches.sort((a, b) => a.start - b.start)) {
    const next = {
      start: Math.max(0, match.start - radius),
      end: Math.min(segment.text.length, match.end + radius),
    }
    const previous = windows.at(-1)
    if (previous && next.start <= previous.end) previous.end = Math.max(previous.end, next.end)
    else windows.push(next)
  }
  const text = windows
    .map(
      (w, i) =>
        `${w.start > 0 && i === 0 ? '…' : ''}${scrubExcerpt(segment.text, w.start, w.end)}${w.end < segment.text.length ? '…' : ''}`,
    )
    .join('')
  return { ...segment, text }
}

export function verifyQuotes(
  raw: RawExtraction,
  segments: TranscriptSegment[],
  options: QuoteOptions = {},
): VerifiedQuotes {
  const dropped: string[] = []
  const cache = new Map<string, ReturnType<typeof indexed>>()
  const matched = raw.memories.flatMap((memory, index) => {
    const matches = memory.quotes.slice(0, 2).flatMap((q) => {
      const found = q.trim() ? findQuote(q, segments, cache) : undefined
      return found ? [found] : []
    })
    options.onVerified?.(index, matches.length > 0)
    if (!matches.length) {
      dropped.push(`No verified quote: ${scrubExcerpt(memory.summary)}`)
      return []
    }
    return [{ memory, matches }]
  })
  const bySegment = new Map<number, Match[]>()
  for (const { matches } of matched)
    for (const match of matches) {
      const list = bySegment.get(match.segment) ?? []
      list.push(match)
      bySegment.set(match.segment, list)
    }
  const evidence = Array.from(bySegment, ([index, matches]) =>
    excerpt(segments[index]!, matches, options.window ?? 400),
  )
  const evidenceIndexes = new Map(Array.from(bySegment.keys(), (index, i) => [index, i]))
  const memories = matched.map(({ memory, matches }) => {
    const { quotes: _quotes, ...rest } = memory
    return {
      ...rest,
      summary: scrubExcerpt(memory.summary),
      literal: memory.literal === null ? null : scrubExcerpt(memory.literal),
      citations: matches.map((m) => ({
        evidence: evidenceIndexes.get(m.segment)!,
        quote: scrubExcerpt(segments[m.segment]!.text, m.start, m.end),
      })),
    }
  })
  return { memories, evidence, dropped }
}
