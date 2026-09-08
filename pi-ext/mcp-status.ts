/**
 * Phosphor mcp-status extension — bundled into every Phosphor session via
 * `pi --mode rpc -e <this file>`.
 *
 * The MCP adapter knows, per server, whether it is connected, needs
 * authorization, failed, or is serving cached metadata. It publishes that as a
 * structured snapshot on pi's shared extension event bus
 * (`state.statusEvents = pi.events` in the adapter's index.ts), but pi's RPC
 * has no channel for it, so a front-end can otherwise only read the adapter's
 * one-line footer sentence — which says nothing per server.
 *
 * This forwards the snapshot verbatim to Phosphor through `ctx.ui.setStatus`,
 * which Phosphor already routes per session. Nothing is inferred or reworded: if
 * the adapter is absent or an older version stops publishing, the status key
 * simply never appears and Phosphor's connector rows show no state rather than a
 * guess.
 *
 * Wire contract: status key `phosphor-mcp-status`, JSON of the adapter's
 * `McpStatusSnapshot`. Consumer: `src/features/connectors/mcpStatus.ts`.
 */

/** The adapter's event name, versioned by the adapter (`types.ts`). */
const ADAPTER_STATUS_EVENT = 'pi-mcp-adapter/status/v1'
const STATUS_KEY = 'phosphor-mcp-status'

interface PiExtensionApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  events?: { on(event: string, handler: (payload: unknown) => void): void }
}

interface ExtensionContext {
  ui?: { setStatus?(key: string, text: string | undefined): void }
}

export default function mcpStatusExtension(pi: PiExtensionApi): void {
  // The bus handler receives only the payload — no context — so a context is
  // captured from lifecycle events, which is also how context-breakdown.ts
  // reaches `ctx.ui`.
  let latestContext: ExtensionContext | undefined
  let latestSnapshot: string | undefined

  function publish(): void {
    const setStatus = latestContext?.ui?.setStatus
    if (typeof setStatus !== 'function' || latestSnapshot === undefined) return
    try {
      setStatus.call(latestContext!.ui, STATUS_KEY, latestSnapshot)
    } catch {
      // A status push must never break a turn.
    }
  }

  pi.events?.on(ADAPTER_STATUS_EVENT, (payload) => {
    if (!payload || typeof payload !== 'object') return
    const snapshot = payload as { servers?: unknown }
    // Only forward the shape Phosphor parses; anything else would be noise the
    // renderer has to defend against a second time.
    if (!Array.isArray(snapshot.servers)) return
    try {
      latestSnapshot = JSON.stringify(payload)
    } catch {
      return
    }
    publish()
  })

  const remember = (_event: unknown, ctx: unknown): void => {
    latestContext = ctx as ExtensionContext
    // Re-push on settle: a snapshot that arrived before any context existed
    // (servers connect during startup) would otherwise never be delivered.
    publish()
  }

  pi.on('session_start', remember)
  pi.on('agent_settled', remember)
  pi.on('turn_end', remember)
}
