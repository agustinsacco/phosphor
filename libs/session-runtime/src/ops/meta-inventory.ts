import type { AuditLog } from './audit'
import type { AgentJob, JobStore } from './jobs'
import { requestPage } from './ports'
import { principalKey } from './principals'
import {
  compactRowField,
  dataResult,
  fields,
  op,
  pageInventory,
  pageLimit,
  pageOffset,
  rowTime,
  surfaceInventory,
} from './results'

export function auditInventory(audit: Pick<AuditLog, 'list'>) {
  return op<{ lane?: string; limit?: number }>(async ({ lane, limit: declared }, ctx) => {
    const limit = surfaceInventory(ctx) ? (declared ?? 50) : pageLimit(ctx, declared)
    const rows = await audit.list({ laneRef: lane, beforeId: requestPage(ctx), limit: limit + 1 })
    return pageInventory(
      rows,
      ctx,
      {
        ...fields('id'),
        at: (r) => rowTime(r.at),
        ...fields('op', 'decision', 'laneRef', 'result'),
      },
      { limit, surface: { limit }, keyset: (r) => r.id },
    )
  })
}

function jobSummary({ jobId, op, state, createdAt, updatedAt, result }: AgentJob) {
  return {
    jobId,
    op,
    state,
    createdAt,
    updatedAt,
    resultPreview: result ? compactRowField(result.text) : null,
  }
}

type JobSummary = ReturnType<typeof jobSummary>
const jobColumns = {
  ...fields('jobId', 'op', 'state'),
  started: (r: JobSummary) => rowTime(r.createdAt),
  finished: (r: JobSummary) => (r.state === 'running' ? '' : rowTime(r.updatedAt)),
  result: (r: JobSummary) => r.resultPreview ?? '',
}

export function jobInventory(jobs: Pick<JobStore, 'list'>) {
  return op((_, ctx) => {
    const creator = principalKey(ctx.principal)
    // Surfaces historically received the latest jobs in full, without a continuation.
    if (surfaceInventory(ctx)) return dataResult(jobs.list(creator))
    const limit = pageLimit(ctx)
    const start = pageOffset(ctx)
    const summaries = jobs.list(creator, start, limit + 1).map(jobSummary)
    return pageInventory(summaries, ctx, jobColumns, { windowOffset: start, limit })
  })
}
