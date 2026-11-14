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
function excerptRanges(claim: StageClaim, window: TranscriptWindow): ExcerptRange[] {
  const ranges = claim.quotes
    .map(({ segment, quote }) => {
      const text = window.segments[Number(segment.slice(1)) - 1]!.text
      const at = text.indexOf(quote)
      const before = [...text.slice(0, at).matchAll(new RegExp(ELISION, 'g'))].at(-1)
      const after = ELISION.exec(text.slice(at + quote.length))
      return {
        segment,
        start: Math.max(at - 600, before ? before.index + before[0].length : 0),
        end: Math.min(
          at + quote.length + 600,
          after ? at + quote.length + after.index : text.length,
        ),
      }
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
