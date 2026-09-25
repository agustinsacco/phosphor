/**
 * The connector authorization flow.
 *
 * Phosphor does not implement OAuth and does not hold connector tokens. The MCP
 * adapter already does PKCE, dynamic client registration, a loopback callback
 * server and token custody in the OS credential store — so this store only
 * *drives* it, through the adapter's own `/mcp-auth <server>` command (an
 * extension command, so no model runs and no tokens are spent).
 *
 * There are two ways to reach that command, and the difference is which
 * process runs it:
 *
 * - **Headless (default).** `mcp:authorize` spawns a throwaway
 *   `pi --mode rpc --no-session` in the main process, which owns the flow and
 *   pushes progress on `mcp:authState`. Settings works with nothing open,
 *   which is when people actually go there.
 * - **In-session.** The adapter also auto-authenticates mid-turn when a model
 *   calls a tool whose server has no token. That prompt arrives on a live
 *   session's extension-UI channel, and `stores/extensionUi.ts` routes it here
 *   so the same card handles it.
 *
 * The load-bearing rule in both paths: **never auto-answer the adapter's
 * pending input request.** pi's RPC has no server→client cancel, so when the
 * loopback callback wins the race the adapter silently abandons its prompt and
 * Phosphor is never told. An empty or cancelled answer sent "to tidy up" wins
 * that race instead and throws `OAuth authentication cancelled` — killing a
 * flow that already succeeded. A pending request is left pending; only an
 * explicit user Cancel answers it.
 *
 * See docs/mcp.md.
 */
import { create } from 'zustand'
import type { ConnectorAuthState } from '@shared/models'
import type { ConnectorCheckResult, ReconnectNotice } from '@shared/connectors'
import { piCallOk } from '@/lib/rpc'

export type ConnectFlow =
  | { phase: 'starting'; sessionId?: string }
  | {
      phase: 'awaiting-browser'
      authorizationUrl: string
      /** Set only for an in-session flow: the pending request to answer. */
      sessionId?: string
      requestId?: string
    }
  | { phase: 'connected' }
  | { phase: 'failed'; message: string }

interface ConnectorsState {
  /** serverName → flow. One flow per server; connectors are independent. */
  flows: Record<string, ConnectFlow>

  /**
   * Authorize a connector. Uses the headless main-process flow, which needs no
   * session; `sessionId` is only for the in-session case, where a live pi
   * process already owns the adapter.
   */
  connect: (serverName: string, sessionId?: string) => Promise<void>
  /** A `mcp:authState` push from the headless flow. */
  headlessState: (serverName: string, state: ConnectorAuthState) => void
  /** Adapter asked for authorization inside a live session. */
  promptReceived: (input: {
    sessionId: string
    serverName: string
    authorizationUrl: string
    requestId: string
  }) => void
  /** The adapter's own verdict on an in-session flow. */
  settle: (serverName: string, outcome: 'success' | 'failure', detail?: string) => void
  /** Answer the pending prompt with a pasted callback URL. */
  submitCallbackUrl: (serverName: string, url: string) => void
  /** Explicit user cancel — the only case where Phosphor answers the prompt. */
  cancel: (serverName: string) => void
  /** Clear a settled flow's card. */
  dismiss: (serverName: string) => void
  /** `/mcp logout <server>` — the adapter removes the stored credentials. */
  disconnect: (serverName: string, sessionId?: string) => Promise<void>
  /**
   * Reload one server inside a live session: `/mcp reconnect <server>` closes
   * the session's connection and opens a fresh one, re-reading the server's
   * tools. pi acknowledges the command before the adapter has finished, so
   * this resolves on the adapter's own notice (`reloadNoticed`), or as
   * `unknown` when none arrives. Always resolves.
   */
  reload: (sessionId: string, serverName: string) => Promise<ConnectorCheckResult>
  /** A reconnect notice from a live session. Settles a pending `reload`. */
  reloadNoticed: (sessionId: string, notice: ReconnectNotice) => void
}

/** A reconnect that opens a fresh HTTP connection; slow servers exist. */
export const RELOAD_TIMEOUT_MS = 45 * 1000

/**
 * Pending reloads, keyed by session and server. Outside the store because
 * nothing renders from them — the tab renders the promise's result.
 */
const pendingReloads = new Map<
  string,
  { promise: Promise<ConnectorCheckResult>; settle: (result: ConnectorCheckResult) => void }
>()

const reloadKey = (sessionId: string, serverName: string): string => `${sessionId}/${serverName}`

function setFlow(
  flows: Record<string, ConnectFlow>,
  serverName: string,
  flow: ConnectFlow | undefined,
): Record<string, ConnectFlow> {
  const next = { ...flows }
  if (flow) next[serverName] = flow
  else delete next[serverName]
  return next
}

/**
 * Extension commands are dispatched as prompts; pi runs them immediately and
 * they manage their own LLM interaction, which for `/mcp-*` is none at all.
 */
async function command(sessionId: string, message: string): Promise<boolean> {
  return piCallOk(sessionId, { type: 'prompt', message })
}

export const useConnectorsStore = create<ConnectorsState>((set, get) => ({
  flows: {},

  connect: async (serverName, sessionId) => {
    set((s) => ({
      flows: setFlow(s.flows, serverName, {
        phase: 'starting',
        ...(sessionId ? { sessionId } : {}),
      }),
    }))
    if (sessionId) {
      const ok = await command(sessionId, `/mcp-auth ${serverName}`)
      if (!ok) {
        set((s) => ({
          flows: setFlow(s.flows, serverName, {
            phase: 'failed',
            message: 'pi refused the /mcp-auth command — is the MCP adapter installed?',
          }),
        }))
      }
      return
    }
    try {
      await window.phosphor.invoke('mcp:authorize', serverName)
    } catch (error) {
      set((s) => ({
        flows: setFlow(s.flows, serverName, {
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      }))
    }
  },

  headlessState: (serverName, state) => {
    set((s) => ({
      flows: setFlow(
        s.flows,
        serverName,
        state.phase === 'awaiting-browser'
          ? { phase: 'awaiting-browser', authorizationUrl: state.authorizationUrl }
          : state,
      ),
    }))
  },

  promptReceived: ({ sessionId, serverName, authorizationUrl, requestId }) => {
    set((s) => ({
      flows: setFlow(s.flows, serverName, {
        phase: 'awaiting-browser',
        sessionId,
        authorizationUrl,
        requestId,
      }),
    }))
    void window.phosphor.invoke('app:openExternal', authorizationUrl).catch(() => {
      // The card shows the URL, so a blocked browser launch is recoverable.
    })
  },

  settle: (serverName, outcome, detail) => {
    set((s) => ({
      flows: setFlow(
        s.flows,
        serverName,
        outcome === 'success'
          ? { phase: 'connected' }
          : { phase: 'failed', message: detail ?? 'Authorization failed.' },
      ),
    }))
  },

  submitCallbackUrl: (serverName, url) => {
    const flow = get().flows[serverName]
    if (flow?.phase !== 'awaiting-browser') return
    if (flow.sessionId && flow.requestId) {
      void window.phosphor.invoke('pi:extensionUiResponse', flow.sessionId, {
        type: 'extension_ui_response',
        id: flow.requestId,
        value: url.trim(),
      })
    } else {
      void window.phosphor.invoke('mcp:submitAuthCallback', serverName, url.trim())
    }
    set((s) => ({ flows: setFlow(s.flows, serverName, { phase: 'starting' }) }))
  },

  cancel: (serverName) => {
    const flow = get().flows[serverName]
    if (flow?.phase === 'awaiting-browser' && flow.sessionId && flow.requestId) {
      void window.phosphor.invoke('pi:extensionUiResponse', flow.sessionId, {
        type: 'extension_ui_response',
        id: flow.requestId,
        cancelled: true,
      })
    } else {
      void window.phosphor.invoke('mcp:cancelAuth', serverName)
    }
    set((s) => ({ flows: setFlow(s.flows, serverName, undefined) }))
  },

  dismiss: (serverName) => set((s) => ({ flows: setFlow(s.flows, serverName, undefined) })),

  disconnect: async (serverName, sessionId) => {
    // Logout is the adapter clearing its own credential-store entry. With no
    // live session there is nothing to ask, so the config removal that follows
    // in the tab is the whole action and the tokens are left for the next
    // session to clear — stated in the UI rather than silently skipped.
    if (sessionId) await command(sessionId, `/mcp logout ${serverName}`)
    set((s) => ({ flows: setFlow(s.flows, serverName, undefined) }))
  },

  reload: (sessionId, serverName) => {
    const key = reloadKey(sessionId, serverName)
    const pending = pendingReloads.get(key)
    if (pending) return pending.promise

    let settle!: (result: ConnectorCheckResult) => void
    const promise = new Promise<ConnectorCheckResult>((resolve) => {
      const timer = setTimeout(
        () =>
          settle({ serverName, outcome: 'unknown', detail: 'The adapter did not answer in time.' }),
        RELOAD_TIMEOUT_MS,
      )
      settle = (result) => {
        if (pendingReloads.get(key)?.promise !== promise) return
        pendingReloads.delete(key)
        clearTimeout(timer)
        resolve(result)
      }
    })
    pendingReloads.set(key, { promise, settle })

    void command(sessionId, `/mcp reconnect ${serverName}`).then((ok) => {
      if (!ok) {
        settle({
          serverName,
          outcome: 'unknown',
          detail: 'pi refused /mcp — is the pi-mcp-adapter package installed?',
        })
      }
    })
    return promise
  },

  reloadNoticed: (sessionId, notice) => {
    pendingReloads.get(reloadKey(sessionId, notice.serverName))?.settle(notice)
  },
}))

/** Subscribe the store to headless flow pushes. Called once, from App. */
export function attachConnectorAuthListener(): () => void {
  return window.phosphor.onMcpAuthState(({ serverName, state }) => {
    useConnectorsStore.getState().headlessState(serverName, state)
  })
}
