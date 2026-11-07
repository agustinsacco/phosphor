import type { BrainEvidence, BrainJob } from '@phosphor/shared/brain'
import type { BrainLearningStart } from '@phosphor/shared/brain-learning-jobs'
import { type Data, identifier } from './data'
import type { Evidence } from './evidence'
import { attemptKey, type LearningReceipt } from './learning-receipts'
import { LEARNING_BYTES } from './learning-validation'
import * as validate from './validation'
import { createHash } from 'node:crypto'

/** 1999 UTF-16 code units of overlap cover every supported <=2000-unit quote. */
function chunks(text: string): string[] {
  const result: string[] = []
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 16000, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
    result.push(text.slice(offset, end))
    if (end === text.length) break
    offset = end - 1999
    if (/[\uDC00-\uDFFF]/.test(text[offset]!)) offset--
  }
  return result
}
export function prepareInputs(
  data: Data,
  input: BrainLearningStart,
): { receipt: LearningReceipt; sources: BrainEvidence[] } {
  const sources: BrainEvidence[] = []
  const maps = input.evidence.map((item) => {
    const { text, ...metadata } = item
    const storedChunks = chunks(text).map((text, index) => {
      const entryId = identifier('learning-input', input.jobId, item.evidenceId, index)
      const id = identifier('evidence', input.scope, input.checkpoint.source.sessionId, entryId)
      validate.check(!data.tombstoned(id), 'Learning evidence was forgotten')
      sources.push({
        id,
        entryId,
        scope: input.scope,
        sessionId: input.checkpoint.source.sessionId,
        parentId: item.entryId,
        rootIds: [...new Set(item.rootIds)].sort(),
        branch: input.branch,
        role: item.role,
        label: `Learning ${item.sourceType} · ${item.role} · ${item.entryId}`,
        observedAt: data.now(),
        text,
        hash: createHash('sha256').update(text).digest('hex'),
      })
      const { text: _text, ...sourceMetadata } = sources.at(-1)!
      return { id, metadataHash: identifier(sourceMetadata) }
    })
    return { ...metadata, chunks: storedChunks }
  })
  validate.check(
    sources.length <= 2000 && data.count('evidence') + sources.length <= 10000,
    'Local evidence capacity reached',
  )
  validate.check(data.count('learningInputs') < 1000, 'Local learning receipt capacity reached')
  validate.check(
    Number(
      data.db
        .prepare(
          `SELECT count(*) AS n FROM documents WHERE kind='jobs' AND json_type(value,'$.learning')='object'`,
        )
        .get()?.n,
    ) < 1000,
    'Local learning job capacity reached',
  )
  validate.check(
    Number(data.db.prepare('SELECT count(*) AS n FROM learning_coverage').get()?.n) +
      input.covered.length <=
      100000,
    'Local learning coverage capacity reached',
  )
  const { evidence: _evidence, ...metadata } = input
  const receipt: LearningReceipt = {
    ...metadata,
    evidence: maps,
    evidenceIds: sources.map((item) => item.id),
    attemptKey: attemptKey(input.scope, input.covered),
  }
  validate.bounded(receipt, LEARNING_BYTES)
  validate.bounded(sources, LEARNING_BYTES)
  return { receipt, sources }
}
export function learningJob(
  data: Data,
  input: BrainLearningStart,
  evidenceIds: string[],
  coveredCount: number,
): BrainJob {
  return {
    id: input.jobId,
    scope: input.scope,
    evidenceIds,
    model: { provider: input.binding.provider, id: input.binding.modelId },
    ...data.revision(),
    state: 'queued',
    fence: 0,
    createdAt: data.now(),
    updatedAt: data.now(),
    sessionPath: null,
    error: null,
    learning: {
      ...input.checkpoint,
      target: input.target,
      branch: input.branch,
      binding: input.binding,
      ...(input.retryJobId !== undefined ? { retryOf: input.retryJobId } : {}),
      coveredCount: input.retryJobId !== undefined ? 0 : coveredCount,
      newCount:
        input.retryJobId !== undefined ? input.covered.length : input.covered.length - coveredCount,
      usage: null,
      outcome: null,
    },
  }
}
export function saveInputs(
  data: Data,
  evidence: Evidence,
  input: LearningReceipt,
  sources: BrainEvidence[],
): void {
  for (const source of sources) evidence.write(source)
  data.put('learningInputs', input.jobId, input.scope, { hash: identifier(input), value: input })
}
