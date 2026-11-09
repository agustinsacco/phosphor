import type { BrainExtractionView } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { readEntries, transcriptSegments, transcriptAtLeaf } from './transcript'
import { scrubExcerpt } from './secrets'

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
  try {
    source.segments = transcriptSegments(
      transcriptAtLeaf(await readEntries(record.sessionPath), record.leafId),
    )
      .slice(-300)
      .map((segment) => {
        const text = scrubExcerpt(segment.text)
        return {
          ...segment,
          text: text.length > 4000 ? text.slice(0, 4000) + '\n[segment clipped]' : text,
        }
      })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    source.exists = false
  }
  return { ...record, source }
}
