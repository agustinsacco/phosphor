/**
 * One connector's status, in the words Settings → Connectors uses on every
 * machine: pi's state from a check (This Mac's per-server inspection, a Host's
 * reviewed `pi mcp list`), or why there is none.
 */
import type { McpServerState } from '@shared/mcp'

/** Human label for a state pi reported, with the tool count it found. */
export function stateLabel(state: McpServerState, tools = 0): string {
  switch (state) {
    case 'connected':
      return `Up · ${String(tools)} tool${tools === 1 ? '' : 's'}`
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

/**
 * A row's status: Disabled, the last state pi reported (kept while a new check
 * runs), or Checking…, Check failed or Not checked. A failed check says
 * nothing about the server, so it never reads as Down.
 */
export function connectorStatus(
  enabled: boolean,
  status: { state?: McpServerState; tools?: number; checking?: boolean; failed?: boolean },
): { state?: McpServerState; label: string } {
  if (!enabled) return { state: 'disabled', label: 'Disabled' }
  const state = status.failed ? undefined : status.state
  if (state)
    return {
      state,
      label: `${stateLabel(state, status.tools)}${status.checking ? ' · checking…' : ''}`,
    }
  return {
    label: status.checking ? 'Checking…' : status.failed ? 'Check failed' : 'Not checked',
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
