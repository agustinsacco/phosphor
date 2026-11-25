import { isUuid } from '@phosphor/shared/control-api'
import { parseRoutineHistory } from '@phosphor/shared/host-protocol-routines'
import type { AgentMessage } from '@phosphor/shared/rpc'
import { extractText } from '@phosphor/session-runtime/pi/session-content'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op, dataResult } from '@phosphor/session-runtime/ops/results'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { readTranscript } from '../../lanes/transcript/read'
import { createTranscriptCache } from '../../lanes/transcript/cache'
import { surfaceAdmits } from '../binding'
import { laneRefFor } from '../lane-ref'
import { contentPage } from './artifacts'
import type { DaemonHandlerDeps } from './index'
import { resourceCall } from './resources-call'

type RunPage = { id?: string; offset?: number; output?: boolean }
const canReadOutput = (ctx: OpHandlerContext) =>
  ctx.principal.kind === 'surface' &&
  surfaceAdmits(ctx.principal, { caps: ['routines', 'sessions.read'] })

/** Plain text, never an inline image payload or pi's private message metadata. */
function conversationText(message: AgentMessage) {
  if (message.role === 'bashExecution') return `bash: ${message.command}\n${message.output}`
  if (message.role === 'compactionSummary' || message.role === 'branchSummary')
    return `${message.role}: ${message.summary}`
  const content = 'content' in message ? message.content : undefined
  const body = Array.isArray(content)
    ? content
        .map((block) => {
          if (block?.type === 'text') return block.text
          if (block?.type === 'toolCall') return `${block.name}(${JSON.stringify(block.arguments)})`
          if (block?.type === 'thinking') return block.thinking
          return `[${block?.type ?? 'attachment'}]`
        })
        .join('\n')
    : extractText(content)
  return `${message.role}: ${body || ('errorMessage' in message && message.errorMessage) || ''}`
}

export function routineRunHandlers(deps: DaemonHandlerDeps) {
  const cache = createTranscriptCache()
  const list = op<RunPage>(async ({ id, offset = 0, output }, ctx) => {
    const rows = parseRoutineHistory(
      await resourceCall(
        deps,
        id ? 'routines.history' : 'routines.activity',
        id ? { routineId: id, offset } : { offset },
      ),
    )
    if (!rows) throw new OpRefusal('unavailable', 'Routine activity is unavailable.')
    const refs = new Map(
      deps.store
        .listLanes()
        .filter((l) => l.sessionFile && !l.removedAt)
        .map((l) => [l.sessionFile, laneRefFor(deps.selfIds(), l.laneId)]),
    )
    return dataResult(
      rows.map((row) => {
        const path = deps.routines?.sessionPathForRun?.(row.id)
        const laneRef = path && refs.get(path)
        if (laneRef) return { ...row, laneRef }
        return output && path && canReadOutput(ctx) ? { ...row, savedOutput: true } : row
      }),
    )
  })
  return {
    'routine.activity': list,
    'routine.history': op<RunPage & { runId?: string }>((args, ctx) => {
      if (args.runId === undefined) return list(args, ctx)
      if (!canReadOutput(ctx))
        throw new OpRefusal('forbidden', 'This connection cannot read run output.')
      if (!isUuid(args.runId) || Object.keys(args).length !== 1)
        throw new OpRefusal('bad-request', 'Name one routine run.')
      ctx.signal.throwIfAborted()
      const path = deps.routines?.sessionPathForRun?.(args.runId)
      const unavailable = 'The saved conversation is unavailable on this machine.'
      if (!path || !deps.sessionsRoot) throw new OpRefusal('unavailable', unavailable)
      const result = readTranscript({
        sessionFile: path,
        sessionsRoot: deps.sessionsRoot,
        laneId: args.runId,
        cache,
        onFailure: () => cache.delete(args.runId!),
      })
      if (result.kind !== 'messages')
        throw new OpRefusal(result.kind === 'too-large' ? 'too-large' : 'unavailable', unavailable)
      return contentPage(result.messages.map(conversationText).join('\n\n'), {}, ctx)
    }),
  }
}
