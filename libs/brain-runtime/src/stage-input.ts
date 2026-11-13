import type { TranscriptSegment } from '@phosphor/memory-engine/types'
import type { StageInput } from './stage-types'
import { extractPrompt } from './stage-prompts/extract'
import { identityPrompt } from './stage-prompts/identity'
import { parentsPrompt } from './stage-prompts/parents'
import { reconcilePrompt } from './stage-prompts/reconcile'
import { makeWindow } from './windows'

export function segmentInputs(
  selected: TranscriptSegment[],
  source: TranscriptSegment[],
): NonNullable<StageInput['segments']> {
  return selected.map((s) => {
    const index = source.findIndex(
      (v) =>
        v.entryId === s.entryId &&
        v.role === s.role &&
        v.label === s.label &&
        v.text.includes(s.text),
    )
    if (index < 0) throw new Error('Source segment missing')
    const start = source[index]!.text.indexOf(s.text)
    return { entryId: s.entryId, index, start, end: start + s.text.length }
  })
}
export function rebuildPrompt(
  stage: string,
  input: StageInput,
  source: TranscriptSegment[],
): string {
  const selected = (input.segments ?? []).map((s) => {
    const segment = source[s.index]
    if (!segment || segment.entryId !== s.entryId || s.end > segment.text.length)
      throw new Error('Source segment unavailable')
    return { ...segment, text: segment.text.slice(s.start, s.end) }
  })
  if (stage === 'extract') return extractPrompt(makeWindow(selected), input.registry ?? [])
  if (stage === 'parents')
    return parentsPrompt(input.requested ?? [], input.registry ?? [], makeWindow(selected).text)
  if (stage === 'identity') return identityPrompt(input.rows ?? [])
  if (stage === 'reconcile') return reconcilePrompt(input.rows ?? [])
  throw new Error('Unknown stage input')
}
