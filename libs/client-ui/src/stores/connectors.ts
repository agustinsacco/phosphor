/**
 * The connector sign-in flow.
 *
 * Phosphor does not implement OAuth and does not hold connector tokens. pi's
 * built-in MCP does PKCE, client registration, the loopback callback and
 * token storage, and `pi mcp login <server>` runs all of it with no session
 * open — so this store only *drives* it: main spawns that command
 * (`mcp:authorize`), pi opens the browser itself, and progress arrives on
 * `mcp:authState`. A session already running picks the new credentials up at
 * its next turn.
 *
 * See docs/mcp.md.
 */
import { create } from 'zustand'
import type { ConnectorAuthState } from '@shared/models'

export type ConnectFlow = ConnectorAuthState

interface ConnectorsState {
  /** serverName → flow. One flow per server; connectors are independent. */
  flows: Record<string, ConnectFlow>

  /** Start `pi mcp login` for a server. */
  connect: (serverName: string, workspacePath?: string) => Promise<void>
  /** A `mcp:authState` push. */
  received: (serverName: string, state: ConnectorAuthState) => void
  /** Abandon a sign-in in progress. */
  cancel: (serverName: string) => void
  /** Clear a settled flow's card. */
  dismiss: (serverName: string) => void
}

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

export const useConnectorsStore = create<ConnectorsState>((set) => ({
  flows: {},

  connect: async (serverName, workspacePath) => {
    set((s) => ({ flows: setFlow(s.flows, serverName, { phase: 'starting' }) }))
    try {
      await window.phosphor.invoke('mcp:authorize', serverName, workspacePath)
    } catch (error) {
      set((s) => ({
        flows: setFlow(s.flows, serverName, {
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      }))
    }
  },

  received: (serverName, state) => {
    set((s) => ({ flows: setFlow(s.flows, serverName, state) }))
  },

  cancel: (serverName) => {
    void window.phosphor.invoke('mcp:cancelAuth', serverName)
    set((s) => ({ flows: setFlow(s.flows, serverName, undefined) }))
  },

  dismiss: (serverName) => set((s) => ({ flows: setFlow(s.flows, serverName, undefined) })),
}))

/** Subscribe the store to sign-in pushes. Called once, from App. */
export function attachConnectorAuthListener(): () => void {
  return window.phosphor.onMcpAuthState(({ serverName, state }) => {
    useConnectorsStore.getState().received(serverName, state)
  })
}
