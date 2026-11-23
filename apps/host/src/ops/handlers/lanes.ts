import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'

/**
 * Lane listing, search, reading, creation, resume, stop, archive, delete, move, export and read marks. Empty until H1 lands: its ops are listed in `PENDING_HANDLERS`
 * and the dispatcher answers them `unsupported`.
 */
export function laneHandlers(_deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {}
}
