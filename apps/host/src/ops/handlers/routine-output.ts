import { lstatSync } from 'node:fs'
import { isUuid } from '@phosphor/shared/control-api'
import { parseRoutineHistory, ROUTINE_LIMITS } from '@phosphor/shared/host-protocol-routines'
import type { AgentMessage } from '@phosphor/shared/rpc'
import { extractText } from '@phosphor/session-runtime/pi/session-content'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import {
  op,
  pageInventory,
  pageLimit,
  pageOffset,
  routineRunColumns,
  surfaceInventory,
} from '@phosphor/session-runtime/ops/results'
import { requestPage } from '@phosphor/session-runtime/ops/ports'
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

/** Only a list hint: the open-time reader still verifies and bounds the file. */
function hasTranscript(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

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
  const list = op<RunPage>(async ({ id, offset, output }, ctx) => {
    const start = requestPage(ctx) === undefined ? (offset ?? 0) : pageOffset(ctx)
    const surface = surfaceInventory(ctx)
    const limit = surface ? ROUTINE_LIMITS.history : pageLimit(ctx)
    const rows = []
    for (
      let n = start;
      n <= ROUTINE_LIMITS.offset && rows.length <= limit;
      n += ROUTINE_LIMITS.history
    ) {
      const batch = parseRoutineHistory(
        await resourceCall(
          deps,
          id ? 'routines.history' : 'routines.activity',
          id ? { routineId: id, offset: n } : { offset: n },
          ctx.signal,
        ),
      )
      if (!batch) throw new OpRefusal('unavailable', 'Routine activity is unavailable.')
      rows.push(...batch)
      if (batch.length < ROUTINE_LIMITS.history) break
    }
    const refs = new Map(
      deps.store
        .listLanes()
        .filter((l) => l.sessionFile && !l.removedAt)
        .map((l) => [l.sessionFile, laneRefFor(deps.selfIds(), l.laneId)]),
    )
    return pageInventory(
      rows.map((row) => {
        const path = deps.routines?.sessionPathForRun?.(row.id)
        const laneRef = path && refs.get(path)
        if (laneRef) return { ...row, laneRef }
        return output && path && canReadOutput(ctx) && hasTranscript(path)
          ? { ...row, savedOutput: true }
          : row
      }),
      ctx,
      routineRunColumns,
      surfaceInventory,
      { windowOffset: start, limit, ...(surface ? { surface: { limit } } : {}) },
    )
  })
  return {
    'routine.activity': list,
    'routine.history': op<RunPage & { runId?: string }>((args, ctx) => {
      if (args.runId === undefined) {
        if (!args.id)
          throw new OpRefusal(
            'bad-request',
            'Supply a routine id for history; use routine activity for all runs.',
          )
        return list(args, ctx)
      }
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
      const visible = result.messages.filter(
        (m) => (m.role !== 'custom' && m.role !== 'customMessage') || m.display !== false,
      )
      return contentPage(visible.map(conversationText).join('\n\n'), {}, ctx)
    }),
  }
}
