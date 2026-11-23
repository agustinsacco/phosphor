import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'

/**
 * Skills. Empty until H3 lands: its ops are listed in `PENDING_HANDLERS`
 * and the dispatcher answers them `unsupported`.
 */
export function skillHandlers(_deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {}
}
