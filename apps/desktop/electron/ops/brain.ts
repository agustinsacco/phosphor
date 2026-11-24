import type { BrainStatus } from '@phosphor/shared/brain'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { liveOpLane, lanePath, targetLane } from './lanes'
import { op, dataResult } from '@phosphor/session-runtime/ops/results'
const service = async () => (await import('../brain/runtime')).brainService()
async function port(ctx: OpHandlerContext) {
  const p = ctx.principal
  const entry = p.kind === 'agent' ? liveOpLane(p.sessionId) : undefined
  if (!entry || ctx.lane?.sessionId !== entry.session.sessionId)
    throw new OpRefusal('bad-request', 'Brain recall needs the asking lane.')
  const brain = await service()
  return (entry.brain ??= brain.forLane({
    sessionId: entry.session.sessionId,
    title: entry.title,
    cwd: entry.session.workspacePath,
  }))
}
function briefing(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    !('text' in value) ||
    typeof value.text !== 'string' ||
    !('data' in value)
  )
    throw new Error('Invalid Brain reply.')
  return { text: value.text, data: value.data }
}
/** Lane tool text and structured data come from the same indexing-only projection. */
function statusResult(status: BrainStatus, ctx: OpHandlerContext) {
  if (ctx.principal.kind !== 'agent') return dataResult(status)
  const { prefs, embedding, counts, jobs } = status
  return dataResult({
    supported: status.supported,
    prefs: { enabled: prefs.enabled, recall: prefs.recall },
    embedding: { phase: embedding.phase },
    counts: { memories: counts.memories, entities: counts.entities },
    jobs: jobs.map(({ id, state, memories, progress }) => ({
      id,
      state,
      memories,
      progress: progress && { stage: progress.stage, done: progress.done, total: progress.total },
    })),
  })
}
export const brainHandlers = {
  'brain.search': op(async (a, c) => briefing(await (await port(c)).search(a))),
  'brain.flag': op(async (a, c) => briefing(await (await port(c)).flag(a))),
  'brain.status': op(async (_a, c) => statusResult(await (await service()).api.status(), c)),
  'brain.find': op<{ query: string; limit?: number }>(async (args, ctx) =>
    ctx.principal.kind === 'agent'
      ? briefing(await (await port(ctx)).search(args))
      : dataResult(await (await service()).api.find(args.query, args.limit ?? 8)),
  ),
  'brain.queue': op(async (_a, c) =>
    statusResult(
      await (await service()).api.queue({ title: targetLane(c).title, sessionPath: lanePath(c) }),
      c,
    ),
  ),
}
