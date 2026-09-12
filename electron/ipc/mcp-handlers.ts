import { handle } from './handle'
import { homedir } from 'node:os'
import { shell } from 'electron'
import type { ConnectorAuthState } from '@shared/models'
import {
  readMcpCache,
  readMcpConfigs,
  readMcpFile,
  removeMcpServer,
  setMcpServerDisabled,
  upsertMcpServer,
  writeMcpFile,
} from '../pi/mcp-config'
import {
  cancelConnectorAuth,
  startConnectorAuth,
  submitConnectorCallback,
} from '../pi/connector-auth'
import { checkConnector } from '../pi/connector-check'
import { checkPiHealth } from '../pi/health'
import { piProcessEnv } from '../pi/shell-env'
import { piStubPath } from '../pi/stub'
import { broadcast } from '../broadcast'

/**
 * Open the adapter's authorization page.
 *
 * The URL comes out of an extension's prompt text, so it is validated exactly
 * as `app:openExternal` validates a renderer-supplied one: http/https only,
 * never a custom scheme that would hand a local handler an argument. Failing
 * closed still leaves the URL visible in the connector card.
 */
function openAuthPage(url: string): void {
  // E2E drives the stub's fake authorization URL; launching a real browser from
  // CI would be noise at best. Gated on the stub, which is itself gated on
  // `!app.isPackaged`.
  if (piStubPath()) return
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    void shell.openExternal(parsed.toString())
  } catch {
    /* unparseable — the card still shows the raw URL */
  }
}

/** mcp.json chain management for the pi-mcp-adapter (Settings → MCP). */
export function registerMcpHandlers(): void {
  handle('mcp:readConfigs', (_event, workspacePath) => readMcpConfigs(workspacePath))

  handle('mcp:upsertServer', (_event, scope, workspacePath, name, config) =>
    upsertMcpServer(scope, workspacePath, name, config),
  )

  handle('mcp:removeServer', (_event, scope, workspacePath, name) =>
    removeMcpServer(scope, workspacePath, name),
  )

  handle('mcp:setDisabled', (_event, scope, workspacePath, name, disabled) =>
    setMcpServerDisabled(scope, workspacePath, name, disabled),
  )

  handle('mcp:readCache', () => readMcpCache())

  handle('mcp:readFile', (_event, scope, workspacePath) => readMcpFile(scope, workspacePath))

  handle('mcp:writeFile', (_event, scope, workspacePath, content) =>
    writeMcpFile(scope, workspacePath, content),
  )

  handle('mcp:authorize', async (_event, serverName, workspacePath) => {
    const stub = piStubPath()
    const emit = (state: ConnectorAuthState): void =>
      broadcast('mcp:authState', { serverName, state })

    // Resolved here rather than inside the flow so the flow module stays
    // spawn-agnostic and testable against a fake pi.
    const health = stub ? null : await checkPiHealth()
    const binaryPath = stub ? process.execPath : health?.binaryPath
    const prefixArgs = stub ? [stub] : health?.prefixArgs
    if (!binaryPath) {
      emit({ phase: 'failed', message: 'pi is not available.' })
      return
    }

    // A connector without a workspace is legitimate: Settings is reachable
    // from the home screen. Home is the safest cwd — it resolves the global
    // mcp.json chain and no project-scope file.
    void startConnectorAuth({
      serverName,
      cwd: workspacePath ?? homedir(),
      binaryPath,
      ...(prefixArgs ? { prefixArgs } : {}),
      env: stub ? { ELECTRON_RUN_AS_NODE: '1' } : await piProcessEnv(),
      onState: emit,
      openUrl: openAuthPage,
    })
  })

  handle('mcp:submitAuthCallback', (_event, serverName, url) =>
    submitConnectorCallback(serverName, url),
  )

  handle('mcp:cancelAuth', (_event, serverName) => cancelConnectorAuth(serverName))

  handle('mcp:checkServer', async (_event, serverName, workspacePath) => {
    const stub = piStubPath()
    const health = stub ? null : await checkPiHealth()
    const binaryPath = stub ? process.execPath : health?.binaryPath
    const prefixArgs = stub ? [stub] : health?.prefixArgs
    if (!binaryPath) {
      return { serverName, outcome: 'unknown' as const, detail: 'pi is not available.' }
    }
    // Home is the safest cwd for a connector reached from the home screen —
    // it resolves the global mcp.json chain and no project-scope file. Same
    // choice as `mcp:authorize`.
    return checkConnector({
      serverName,
      cwd: workspacePath ?? homedir(),
      binaryPath,
      ...(prefixArgs ? { prefixArgs } : {}),
      env: stub ? { ELECTRON_RUN_AS_NODE: '1' } : await piProcessEnv(),
    })
  })
}
