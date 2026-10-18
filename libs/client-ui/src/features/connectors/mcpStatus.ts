/**
 * Per-server MCP state for Settings → Connectors, read from
 * `pi mcp list --json` (`mcp:list`). That command connects every enabled
 * server once and says what happened, so a row's badge is a fresh answer to
 * "is this up?", not a guess from a session's history.
 */
import type { McpServerReport, McpServerState } from '@shared/mcp'

/** Human label for a row badge. */
export function stateLabel(report: Pick<McpServerReport, 'state' | 'tools'>): string {
  switch (report.state) {
    case 'connected':
      return `Up · ${String(report.tools.length)} tool${report.tools.length === 1 ? '' : 's'}`
    case 'needs-auth':
      return 'Needs sign-in'
    case 'failed':
      return 'Down'
    case 'disconnected':
    case 'closed':
      return 'Disconnected'
    case 'connecting':
      return 'Connecting'
    case 'disabled':
      return 'Disabled'
  }
}

/** Dot colour per state. Only `connected` is green. */
export const STATE_DOT: Record<McpServerState, string> = {
  connected: 'bg-success',
  'needs-auth': 'bg-warning',
  failed: 'bg-danger',
  disconnected: 'bg-danger',
  closed: 'bg-danger',
  connecting: 'bg-info',
  disabled: 'bg-border-strong',
}
