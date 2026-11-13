import type { BrainExtractionView, BrainExtractionCall } from '@phosphor/shared/brain'
import type { BrainStore, TranscriptSegment } from '@phosphor/memory-engine/types'
import { readEntries, transcriptSegments, transcriptAtLeaf } from './transcript'
import { scrubExcerpt } from '@phosphor/memory-engine/secrets'
import { rebuildPrompt } from './stage-input'
import { inputHash } from './windows'
import { repairPrompt } from './stage-call'
import type { StageInput } from './stage-types'

const UNAVAILABLE = 'Prompt not available: the inputs for this step are no longer stored.'
export async function extractionView(
  store: BrainStore,
  jobId: string,
): Promise<BrainExtractionView> {
  const record = store.extraction(jobId)
  const source: BrainExtractionView['source'] = {
    sessionPath: record.sessionPath,
    title: record.title,
    leafId: record.leafId,
    exists: true,
    segments: [],
  }
  let segments: TranscriptSegment[] = []
  try {
    segments = transcriptSegments(
      transcriptAtLeaf(await readEntries(record.sessionPath), record.leafId),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    source.exists = false
  }
  source.segments = segments
    .slice(-300)
    .map((s) => ({ ...s, text: scrubExcerpt(s.text).slice(0, 4000) }))
  const prompts = record.calls.map((call, index) => {
    if (!source.exists) return UNAVAILABLE
    try {
      const prompt = promptFor(store, jobId, call, segments, record.calls[index - 1])
      return inputHash(prompt) === call.inputHash ? prompt : UNAVAILABLE
    } catch {
      return UNAVAILABLE
    }
  })
  return { ...record, prompts, source }
}
function promptFor(
  store: BrainStore,
  jobId: string,
  call: BrainExtractionCall,
  source: TranscriptSegment[],
  previous: BrainExtractionCall | undefined,
): string {
  const saved = store.part(jobId, `input:${call.stage}:${call.part}`, call.inputHash)
  if (!saved) return UNAVAILABLE
  if (call.stage !== 'repair')
    return rebuildPrompt(call.stage, JSON.parse(saved.output) as StageInput, source)
  const repair = JSON.parse(saved.output) as {
    stage: string
    part: number
    hash: string
    error: string
  }
  const original = store.part(jobId, `input:${repair.stage}:${repair.part}`, repair.hash)
  if (!original || !previous) return UNAVAILABLE
  return repairPrompt(
    rebuildPrompt(repair.stage, JSON.parse(original.output) as StageInput, source),
    previous.answer,
    repair.error,
  )
}
