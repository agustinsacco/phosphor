import type { BrainJob, BrainMemory, BrainOrigin, BrainRecall } from '@phosphor/shared/brain'
import type { BrainEntityView, BrainMemoryDetail } from '@phosphor/shared/brain-explore'
import type { BrainTidySuggestionDetail } from '@phosphor/shared/brain-tidy'
import { scrubExcerpt } from '@phosphor/memory-engine/secrets'

/**
 * What Brain Agent sees of stored Brain data. A lane title is the lane's name or its first prompt,
 * stored as written, so every title is scrubbed as stored text is. Lane files never reach it:
 * it needs ids, not paths.
 */
export const curatorTitle = (title: string): string => scrubExcerpt(title)

const origin = (from: BrainOrigin | null): BrainOrigin | null =>
  from && { ...from, title: curatorTitle(from.title) }
const memoryView = (memory: BrainMemory): BrainMemory => ({
  ...memory,
  origin: origin(memory.origin),
})

export const curatorJob = (job: BrainJob): BrainJob => ({
  ...job,
  title: curatorTitle(job.title),
  sessionPath: '',
})

export const curatorMemory = (detail: BrainMemoryDetail): BrainMemoryDetail => ({
  ...detail,
  memory: memoryView(detail.memory),
  history: detail.history.map(memoryView),
  related: detail.related.map((row) => ({ ...row, memory: memoryView(row.memory) })),
  sourcePath: null,
})

export const curatorEntity = (view: BrainEntityView): BrainEntityView => ({
  ...view,
  sources: view.sources.map((source) => ({ ...source, title: curatorTitle(source.title) })),
})

export function curatorSuggestion(
  detail: BrainTidySuggestionDetail | null,
): BrainTidySuggestionDetail | null {
  if (!detail) return null
  const { flag } = detail.suggestion
  return {
    ...detail,
    suggestion: {
      ...detail.suggestion,
      flag: flag && { ...flag, title: curatorTitle(flag.title) },
    },
    subjects: detail.subjects.map((subject) =>
      subject.type === 'memory'
        ? { ...subject, value: curatorMemory(subject.value) }
        : { ...subject, value: curatorEntity(subject.value) },
    ),
  }
}

export const curatorRecall = (recall: BrainRecall): BrainRecall => ({
  ...recall,
  hits: recall.hits.map((hit) => ({ ...hit, memory: memoryView(hit.memory) })),
})
