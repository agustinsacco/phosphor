import type { BrainExtractionOutcome } from '@phosphor/shared/brain'
import type { TranscriptSegment } from '@phosphor/memory-engine/types'
import type { ExtractedPart } from './stage-types'
import { transcriptAtLeaf, transcriptSegments, type LaneEntry } from './transcript'
import { WINDOW_OVERLAP } from './constants'

/** A branch resumes after the deepest shared ancestor, never an entry on the abandoned path. */
export function readBoundary(
  entries: LaneEntry[],
  leaf: string | null,
  previous: string | null,
): {
  fromLeafId: string | null
  branched: boolean
} {
  if (previous === null) return { fromLeafId: null, branched: false }
  const path = transcriptAtLeaf(entries, leaf)
  if (path.some((e) => e.id === previous)) return { fromLeafId: previous, branched: false }
  const earlier = new Set(transcriptAtLeaf(entries, previous).map((e) => e.id))
  return { fromLeafId: path.findLast((e) => e.id && earlier.has(e.id))?.id ?? null, branched: true }
}

/** Keep context edits from the whole selected ancestry, but extract only after the frozen cursor. */
export function incrementalSegments(
  entries: LaneEntry[],
  leaf: string | null,
  from: string | null,
): {
  source: TranscriptSegment[]
  selected: TranscriptSegment[]
} {
  const path = transcriptAtLeaf(entries, leaf)
  const source = transcriptSegments(path)
  if (from === null) return { source, selected: source }
  const boundary = path.findIndex((e) => e.id === from)
  const older = new Set(path.slice(0, boundary + 1).map((e) => e.id))
  const context = source
    .filter((s) => older.has(s.entryId))
    .slice(-WINDOW_OVERLAP)
    .map((s) => ({ ...s, role: 'context' as const }))
  return { source, selected: [...context, ...source.filter((s) => !older.has(s.entryId))] }
}

/** The prompt is advisory; claims supported only by overlap can never become new knowledge. */
export function withoutOverlapClaims(part: ExtractedPart): ExtractedPart {
  const dropped: BrainExtractionOutcome[] = []
  const claims = part.extraction.claims.filter((claim) => {
    if (
      claim.quotes.some(
        (q) => part.window.segments[Number(q.segment.slice(1)) - 1]?.role !== 'context',
      )
    )
      return true
    dropped.push({
      candidate: claim.ref,
      summary: claim.text,
      status: 'dropped',
      reason: 'Claim supported only by previously read context',
    })
    return false
  })
  return {
    ...part,
    extraction: {
      ...part.extraction,
      claims,
      parents: part.extraction.parents.filter(
        (p) => !p.claim || claims.some((c) => c.ref === p.claim),
      ),
      outcomes: [...(part.extraction.outcomes ?? []), ...dropped],
    },
  }
}
