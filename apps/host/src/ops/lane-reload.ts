import { OP_TOOL_NAME } from '@phosphor/shared/ops'
import type { AgentMessage } from '@phosphor/shared/rpc'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { BeforePromptResult } from '@phosphor/session-runtime/pi/lane-reload'
import type { DeferredActions } from './binding'

/** Bounds the record of runs that ended on the tool, should one never be applied. */
const ENDED_ON_TOOL_LIMIT = 256

/**
 * Which sessions' last run ended on the `phosphor` tool's own result: the
 * terminating reply of an op that reloads the lane. Kept across the exit of a
 * process that a model change replaced, so its reload still continues the run.
 */
export function createRunEndings() {
  const ended = new Set<string>()
  return {
    /** From `agent_end`: the run's last message, and whether it is the tool's result. */
    ended(sessionId: string, messages: readonly AgentMessage[]): void {
      const last = messages.at(-1)
      ended.delete(sessionId)
      if (last?.role !== 'toolResult' || last.toolName !== OP_TOOL_NAME) return
      ended.add(sessionId)
      if (ended.size > ENDED_ON_TOOL_LIMIT) ended.delete(ended.values().next().value!)
    },
    /** Read once: a later settle of the same session has its own ending. */
    take(sessionId: string): boolean {
      return ended.delete(sessionId)
    },
  }
}

export type RunEndings = ReturnType<typeof createRunEndings>

export interface LaneReloadActionPorts {
  /** Reloads the lane's live pi now (`reloadLaneNow`). */
  reloadNow(sessionId: string): Promise<BeforePromptResult>
  readonly endings: Pick<RunEndings, 'take'>
  /** The continuation, through the lane runtime like any prompt. */
  prompt(sessionId: string, message: string): Promise<{ success: boolean; error?: string }>
  /** False while a service pause refuses new turns. */
  admitsPrompt(): boolean
  log: RuntimeLog
}

/**
 * Reload-and-continue: once the lane's run settled, reload it whatever its
 * fingerprint, then continue the run only when it ended on the terminating
 * `phosphor` result. A run that ended any other way just reloads.
 */
export function laneReloadAction(
  ports: LaneReloadActionPorts,
): NonNullable<DeferredActions['reload']> {
  return async (item, target) => {
    const endedOnTool = ports.endings.take(target.settledSessionId)
    const outcome = await ports.reloadNow(target.sessionId)
    const applied = outcome === 'applied'
    ports.log('ops', 'lane reload', { sessionId: target.sessionId, outcome, endedOnTool })
    const failed = { ok: false as const, message: `The lane did not reload (${outcome}).` }
    if (!endedOnTool) return applied ? { ok: true } : failed
    if (!ports.admitsPrompt())
      return { ok: false, message: 'The lane did not continue: the Phosphor service is pausing.' }
    const message = applied
      ? `Phosphor reloaded this lane: ${item.what}. Continue.`
      : `Phosphor could not reload this lane (${outcome}); ${item.what} applies on its next reload. Continue.`
    const sent = await ports.prompt(target.sessionId, message)
    if (!sent.success)
      return { ok: false, message: sent.error ?? 'The lane did not take the continuation.' }
    return applied ? { ok: true } : failed
  }
}
