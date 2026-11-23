import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'

/**
 * Files in a lane's folder. Empty until H4 lands: its ops are listed in `PENDING_HANDLERS`
 * and the dispatcher answers them `unsupported`.
 */
export function fileHandlers(_deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {}
}
