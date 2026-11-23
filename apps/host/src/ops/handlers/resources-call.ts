import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { DaemonHandlerDeps } from './index'

/** Use the machine's own feature router, after ops admission. */
export async function resourceCall(
  deps: DaemonHandlerDeps,
  method: string,
  params: unknown,
  signal?: AbortSignal,
) {
  const result = await deps.lanes.calls.call(method, params, () => !signal?.aborted)
  if (result.ok) return result.data
  const { code, message } = result.error
  throw new OpRefusal(
    code === 'internal' || code === 'lane-stopped'
      ? 'unavailable'
      : code === 'unknown-lane'
        ? 'bad-request'
        : code,
    message,
  )
}

export const NO_CONTENT_UNDO = "No Undo: Phosphor doesn't keep the previous content."

/** Daemon implementations which may outlast one answer deadline; none has a safe inverse. */
export const RESOURCE_JOBS = new Set(['skill.install', 'routine.cancel', 'routine.delete'])
