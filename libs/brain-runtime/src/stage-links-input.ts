import type { TranscriptSegment } from '@phosphor/memory-engine/types'
import type { LinksInput, Registry, StageClaim, StageExtraction } from './stage-types'
import type { TranscriptWindow } from './windows'
import { ELISION } from './constants'
import { segmentInputs } from './stage-input'

interface ExcerptRange {
  segment: string
  start: number
  end: number
}
function unelided(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  let start = 0
  for (const marker of text.matchAll(new RegExp(ELISION, 'gu'))) {
    spans.push({ start, end: marker.index })
    start = marker.index + marker[0].length
  }
  return [...spans, { start, end: text.length }]
}
function excerptRanges(claim: StageClaim, window: TranscriptWindow): ExcerptRange[] {
  const ranges = claim.quotes
    .flatMap(({ segment, quote }) => {
      const text = window.segments[Number(segment.slice(1)) - 1]!.text
      // A quote lives in one unelided span; the same words inside a marker are not it.
      const span = unelided(text).find((s) => text.slice(s.start, s.end).includes(quote))
      if (!span) return []
      const at = text.indexOf(quote, span.start)
      return [
        {
          segment,
          start: Math.max(at - 600, span.start),
          end: Math.min(at + quote.length + 600, span.end),
        },
      ]
    })
    .sort((a, b) => Number(a.segment.slice(1)) - Number(b.segment.slice(1)) || a.start - b.start)
  const merged: ExcerptRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous?.segment === range.segment && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

/** Excerpts retain offsets into the frozen source, never copied conversation text. */
export function linksInput(
  extraction: StageExtraction,
  registry: Registry,
  window: TranscriptWindow,
  source: TranscriptSegment[],
): LinksInput {
  const claims = extraction.claims.filter((c) => c.mentions.length >= 2)
  const mentioned = new Set(claims.flatMap((c) => c.mentions))
  const selected = segmentInputs(window.segments, source)
  return {
    entities: [...extraction.entities, ...registry]
      .filter((e) => mentioned.has(e.ref))
      .map(({ ref, kind, label, description }) => ({ ref, kind, label, description })),
    rows: claims.map((c) => ({
      ref: c.ref,
      text: c.text,
      mentions: c.mentions,
      links: c.links,
      excerpts: excerptRanges(c, window).map((e) => {
        const base = selected[Number(e.segment.slice(1)) - 1]!
        return { ...base, segment: e.segment, start: base.start + e.start, end: base.start + e.end }
      }),
    })),
  }
}
