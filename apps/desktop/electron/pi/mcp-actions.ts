import { homedir } from 'node:os'
import type { ConnectorAuthState } from '@shared/models'
import type { McpListResult } from '@shared/mcp'
import {
  listMcpServers as listCliServers,
  loginMcpServer,
  logoutMcpServer as logoutCliServer,
  type PiCli,
} from './mcp-cli'
import { checkPiHealth } from './health'
import { piProcessEnv } from './shell-env'
import { piStubPath } from './stub'

export { cancelMcpLogin } from './mcp-cli'

/**
 * How to run `pi mcp …` here. A connector reached from the home screen has no
 * workspace; home is the safest cwd then — it resolves the global mcp.json
 * and no project file.
 */
export async function piCli(workspacePath: string | undefined): Promise<PiCli | null> {
  const cwd = workspacePath ?? homedir()
  const stub = piStubPath()
  if (stub) {
    return {
      binaryPath: process.execPath,
      prefixArgs: [stub],
      cwd,
      // Inherit the rest: the stub finds its agent dir through PI_CODING_AGENT_DIR.
      env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  // Bypass resolvePiInvoker: MCP needs a fresh probe admitting a present-but-too-old pi.
  const health = await checkPiHealth()
  if (!health.binaryPath) return null
  return {
    binaryPath: health.binaryPath,
    ...(health.prefixArgs ? { prefixArgs: health.prefixArgs } : {}),
    cwd,
    env: await piProcessEnv(),
  }
}

/** Ask pi for connection state in the workspace, or global state from home. */
export async function listMcpServers(workspacePath: string | undefined): Promise<McpListResult> {
  const cli = await piCli(workspacePath)
  if (!cli) return { ok: false, message: 'pi is not available.' }
  return listCliServers(cli)
}

/** Resolve once pi's login starts; pi owns the browser flow and reports its eventual state. */
export async function authorizeMcpServer(
  serverName: string,
  workspacePath: string | undefined,
  onState: (state: ConnectorAuthState) => void,
): Promise<void> {
  const cli = await piCli(workspacePath)
  if (!cli) {
    onState({ phase: 'failed', message: 'pi is not available.' })
    return
  }
  void loginMcpServer(cli, serverName, onState)
}

/** Let pi remove the server's credentials; Phosphor never holds them. */
export async function logoutMcpServer(
  serverName: string,
  workspacePath: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const cli = await piCli(workspacePath)
  if (!cli) return { ok: false, message: 'pi is not available.' }
  return logoutCliServer(cli, serverName)
}
