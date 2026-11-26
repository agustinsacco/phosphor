import type { AuditLog } from './audit'
import type { JobStore } from './jobs'
import { requestPage } from './ports'
import { principalKey } from './principals'
import {
  dataResult,
  fields,
  fitInventory,
  inventoryText,
  op,
  pageInventory,
  pageLimit,
  rowTime,
  surfaceInventory,
} from './results'

export function auditInventory(audit: Pick<AuditLog, 'list'>) {
  return op<{ lane?: string; limit?: number }>(async ({ lane, limit: declared }, ctx) => {
    const surface = surfaceInventory(ctx)
    const limit = surface ? (declared ?? 50) : pageLimit(ctx, declared)
    const rows = await audit.list({ laneRef: lane, beforeId: requestPage(ctx), limit: limit + 1 })
    const data = surface ? rows.slice(0, limit) : fitInventory(rows, limit)
    return {
      text: surface
        ? dataResult(data).text
        : inventoryText(data, {
            ...fields('id'),
            at: (r) => rowTime(r.at),
            ...fields('op', 'decision', 'laneRef', 'result'),
          }),
      data,
      ...(rows.length > data.length ? { next: data.at(-1)!.id } : {}),
    }
  })
}

export function jobInventory(jobs: Pick<JobStore, 'list'>) {
  return op((_, ctx) => {
    const summaries = jobs
      .list(principalKey(ctx.principal))
      .map(({ jobId, op, state, createdAt, updatedAt }) => ({
        jobId,
        op,
        state,
        createdAt,
        updatedAt,
      }))
    return pageInventory(summaries, ctx, {
      ...fields('jobId', 'op', 'state'),
      updated: (r) => rowTime(r.updatedAt),
    })
  })
}
