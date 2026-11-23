import type { ContextFilePrefs } from '@phosphor/shared/context-files'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import {
  contextFileArgs,
  laneControlHandlers,
  laneEffect,
} from '@phosphor/session-runtime/ops/lane-controls'
import { dataResult, op } from '@phosphor/session-runtime/ops/results'
import type { OpHandler, OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'
import { liveSession, requireRuntime, targetLane } from './lane-target'

/** pi-ext/context-files.ts's command: the composer's CLAUDE.md / AGENTS.md checkboxes send it. */
const CONTEXT_FILES_COMMAND = 'phosphor-context-files'

const isOwnLane = (ctx: OpHandlerContext) =>
  ctx.principal.kind === 'agent' && ctx.lane?.sessionId === ctx.principal.sessionId

/** The lane's pin, marker and title as Desktop keeps them: marks in the Host store, the title in pi. */
function markHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  const marks = (ctx: OpHandlerContext, change: { pinned?: boolean; marker?: string }) => {
    const lane = targetLane(ctx)
    const stored = deps.store.getLane(lane.laneId)
    if (!stored) throw new OpRefusal('unavailable', 'That lane is unavailable on this machine.')
    deps.store.setLaneMarks(lane.laneId, change)
    deps.laneRuntime?.publishSummary(lane.laneId)
    return { lane, stored }
  }
  return {
    'lane.rename': op<{ name: string }>(async ({ name }, ctx) => {
      const lane = targetLane(ctx)
      const sessionId = liveSession(ctx, 'rename')
      const result = await requireRuntime(deps.laneRuntime).command(sessionId, {
        type: 'set_session_name',
        name,
      })
      if (!result.success)
        throw new OpRefusal('unavailable', result.error ?? 'pi refused this command.')
      return { text: `Renamed lane to ${name}.`, before: { ref: lane.ref, name: lane.title } }
    }),
    'lane.pin': op<{ on: boolean }>(({ on }, ctx) => {
      const { lane, stored } = marks(ctx, { pinned: on })
      return {
        text: on ? 'Pinned lane.' : 'Unpinned lane.',
        before: { ref: lane.ref, on: stored.pinned === true },
      }
    }),
    // The marker is stored exactly as given, `none` included, as Desktop stores it.
    'lane.marker': op<{ marker: string }>(({ marker }, ctx) => {
      const { lane, stored } = marks(ctx, { marker })
      return {
        text: 'Updated lane marker.',
        before: stored.marker ? { ref: lane.ref, marker: stored.marker } : undefined,
      }
    }),
  }
}

/**
 * A lane's own state: Swarm, model, thinking, marks, PRs, context files,
 * connectors, compaction, reload, notify and view suggestions. The asking
 * lane's own controls are session-runtime's; a surface reaches another lane's
 * context files and connectors through that lane's live pi.
 */
export function laneSelfHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  const own = laneControlHandlers(targetLane)
  return {
    ...own,
    ...markHandlers(deps),
    'contextFiles.set': op<Partial<ContextFilePrefs>>(async (args, ctx) => {
      if (isOwnLane(ctx)) return own['contextFiles.set'](args, ctx)
      const sessionId = liveSession(ctx, 'change context files in')
      const settings = contextFileArgs(args)
      const result = await requireRuntime(deps.laneRuntime).command(sessionId, {
        type: 'prompt',
        message: `/${CONTEXT_FILES_COMMAND} ${settings}`,
      })
      if (!result.success)
        throw new OpRefusal('unavailable', result.error ?? 'The lane refused the change.')
      return { text: settings }
    }),
    'mcp.lane': op<{ server: string; action: 'inspect' | 'reconnect' }>(
      async ({ server, action }, ctx) => {
        const sessionId = liveSession(ctx, 'reach connectors in')
        const result = await requireRuntime(deps.laneRuntime).mcpControl(sessionId, server, action)
        if (!result.ok)
          throw new OpRefusal(result.unsupported ? 'unsupported' : 'unavailable', result.message)
        return dataResult(result)
      },
    ),
    // Placed after the run: the asking lane's own reload ends its run and continues after.
    'lane.reload': op((_a, ctx) => {
      liveSession(ctx, 'reload')
      const what = ctx.reason?.split('\n', 1)[0]?.trim() || 'a reload was requested'
      return { text: `Reloading the lane: ${what}.`, deferred: [{ kind: 'reload', what }] }
    }),
    'ui.open': op<{ target: string }>(({ target }, ctx) => {
      const link = target.startsWith('phosphor://') ? target : `phosphor://${target}`
      return laneEffect(ctx, `Suggested ${link}.`, {
        kind: 'notify',
        message: `Agent suggests opening ${link}`,
        level: 'info',
      })
    }),
  }
}
