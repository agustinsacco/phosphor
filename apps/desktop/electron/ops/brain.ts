import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { liveOpLane, lanePath, targetLane } from './lanes'
import { op, dataResult } from './results'
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
export const brainHandlers = {
  'brain.search': op(async (a, c) => briefing(await (await port(c)).search(a))),
  'brain.flag': op(async (a, c) => briefing(await (await port(c)).flag(a))),
  'brain.status': op(async () => dataResult(await (await service()).api.status())),
  'brain.find': op<{ query: string; limit?: number }>(async ({ query, limit }) =>
    dataResult(await (await service()).api.find(query, limit ?? 8)),
  ),
  'brain.queue': op(async (_a, c) =>
    dataResult(
      await (await service()).api.queue({ title: targetLane(c).title, sessionPath: lanePath(c) }),
    ),
  ),
}
