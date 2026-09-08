/**
 * Reading the MCP adapter's OAuth conversation.
 *
 * The adapter drives OAuth through `ctx.ui.input()` and `ctx.ui.notify()`,
 * which reach Phosphor as ordinary extension-UI requests. Phosphor intercepts the
 * ones that belong to an authorization flow so it can open the browser and
 * show a connector card instead of a bare "paste this URL" text box.
 *
 * These are string contracts with a separately versioned package, so both
 * parsers are deliberately narrow and both fail closed: an unrecognised
 * message falls through to the generic dialog/toast, which is the pre-existing
 * behaviour and always usable. Source: `pi-mcp-adapter/commands.ts`.
 */
import { stripAnsi } from './ansi'

export interface OAuthPrompt {
  serverName: string
  authorizationUrl: string
}

/** First http(s) URL in the text, with any trailing punctuation removed. */
function firstUrl(text: string): string | undefined {
  const match = /https?:\/\/[^\s"'<>)\]]+/.exec(text)
  if (!match) return undefined
  return match[0].replace(/[.,;]+$/, '')
}

/**
 * The adapter's authorization prompt:
 *
 *   Complete <server> OAuth
 *
 *   <osc8 hyperlink>
 *   <authorization url>
 *
 *   Approve access, then paste the full localhost callback URL below.
 *
 * The hyperlink is an OSC 8 escape, so ANSI is stripped before matching.
 */
export function parseOAuthPrompt(message: string): OAuthPrompt | null {
  const text = stripAnsi(message)
  const header = /^\s*Complete\s+(.+?)\s+OAuth\b/.exec(text)
  if (!header) return null
  const serverName = header[1]?.trim()
  if (!serverName) return null
  const authorizationUrl = firstUrl(text)
  if (!authorizationUrl) return null
  try {
    const protocol = new URL(authorizationUrl).protocol
    if (protocol !== 'http:' && protocol !== 'https:') return null
  } catch {
    return null
  }
  return { serverName, authorizationUrl }
}

export interface AuthNotice {
  serverName: string
  outcome: 'success' | 'failure'
  detail?: string
}

/**
 * The adapter's own verdict on a flow, which is what actually tells Phosphor the
 * browser round-trip finished. Status snapshots follow, but they arrive on a
 * reconnect and can lag.
 */
export function parseAuthNotice(message: string): AuthNotice | null {
  const text = stripAnsi(message)
  const success = /^OAuth authentication successful for "(.+?)"/.exec(text)
  if (success?.[1]) return { serverName: success[1], outcome: 'success' }

  const failure = /^OAuth authentication failed for "(.+?)"/.exec(text)
  if (failure?.[1]) return { serverName: failure[1], outcome: 'failure' }

  const errored = /^Failed to authenticate "(.+?)":\s*(.*)$/.exec(text)
  if (errored?.[1]) {
    return {
      serverName: errored[1],
      outcome: 'failure',
      ...(errored[2]?.trim() ? { detail: errored[2].trim() } : {}),
    }
  }
  return null
}

/**
 * The verdict of `/mcp reconnect <server>` — Phosphor's connection test.
 *
 * "Is this connector up?" had no answer without a live session, because
 * per-server state only arrives from the adapter running inside one. The
 * adapter's reconnect command IS the probe: it closes the connection, opens a
 * fresh one, and reports the outcome as a notify. Every branch of
 * `reconnectServer` in `pi-mcp-adapter/commands.ts` emits one of these lines,
 * so the parse covers all of them and fails closed on anything else.
 */
export interface ReconnectNotice {
  serverName: string
  outcome: 'connected' | 'needs-auth' | 'disabled' | 'failed' | 'missing'
  /** Tools the server exposed, on a successful reconnect. */
  toolCount?: number
  resourceCount?: number
  /** The adapter's own message, for a non-success outcome. */
  detail?: string
}

export function parseReconnectNotice(message: string): ReconnectNotice | null {
  const text = stripAnsi(message).trim()

  const ok = /^MCP: Reconnected to (.+?) \((\d+) tools?, (\d+) resources?\)/.exec(text)
  if (ok?.[1]) {
    return {
      serverName: ok[1],
      outcome: 'connected',
      toolCount: Number(ok[2]),
      resourceCount: Number(ok[3]),
    }
  }

  const auth = /^MCP: (.+?) requires OAuth\b/.exec(text)
  if (auth?.[1]) {
    return { serverName: auth[1], outcome: 'needs-auth', detail: 'Sign-in required.' }
  }

  const disabled = /^MCP: (.+?) is disabled\b/.exec(text)
  if (disabled?.[1]) {
    return { serverName: disabled[1], outcome: 'disabled', detail: 'Server is disabled.' }
  }

  const failed = /^MCP: Failed to reconnect to (.+?): ([\s\S]*)$/.exec(text)
  if (failed?.[1]) {
    return {
      serverName: failed[1],
      outcome: 'failed',
      ...(failed[2]?.trim() ? { detail: failed[2].trim() } : {}),
    }
  }

  const missing = /^Server "(.+?)" not found in config/.exec(text)
  if (missing?.[1]) {
    return {
      serverName: missing[1],
      outcome: 'missing',
      detail: 'Not in the resolved mcp.json chain.',
    }
  }

  return null
}

/**
 * What a connection test concluded. `unknown` carries the reason: an
 * unparseable answer, a refused command or a timeout is reported as such
 * rather than rendered as a failing server.
 */
export type ConnectorCheckResult =
  ReconnectNotice | { serverName: string; outcome: 'unknown'; detail: string }
