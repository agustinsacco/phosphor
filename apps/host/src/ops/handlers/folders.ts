import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'

/**
 * Folders. Empty until H3 lands: its ops are listed in `PENDING_HANDLERS`
 * and the dispatcher answers them `unsupported`.
 */
export function folderHandlers(_deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {}
}
