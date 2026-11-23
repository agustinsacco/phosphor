import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'

/**
 * MCP servers, except the per-lane switch. Empty until H2 lands: its ops are listed in `PENDING_HANDLERS`
 * and the dispatcher answers them `unsupported`.
 */
export function mcpHandlers(_deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {}
}
