import { handle } from './handle'
import { homedir } from 'node:os'
import type { ConnectorAuthState } from '@shared/models'
import {
  readMcpConfigs,
  readMcpFile,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
  writeMcpFile,
} from '../pi/mcp-config'
import { planMcpMigration, runMcpMigration } from '../pi/mcp-migration'
import {
  cancelMcpLogin,
  listMcpServers,
  loginMcpServer,
  logoutMcpServer,
  type PiCli,
} from '../pi/mcp-cli'
import { checkPiHealth } from '../pi/health'
import { piProcessEnv } from '../pi/shell-env'
import { piStubPath } from '../pi/stub'
import { broadcast } from '../broadcast'
import { invalidatePiCommands } from './pi-config-handlers'

/**
 * How to run `pi mcp …` here. A connector reached from the home screen has no
 * workspace; home is the safest cwd then — it resolves the global mcp.json
 * and no project file.
 */
async function piCli(workspacePath: string | undefined): Promise<PiCli | null> {
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
  const health = await checkPiHealth()
  if (!health.binaryPath) return null
  return {
    binaryPath: health.binaryPath,
    ...(health.prefixArgs ? { prefixArgs: health.prefixArgs } : {}),
    cwd,
    env: await piProcessEnv(),
  }
}

/** pi's built-in MCP: its two mcp.json files and its `pi mcp` commands (Settings → Connectors). */
export function registerMcpHandlers(): void {
  handle('mcp:readConfigs', (_event, workspacePath) => readMcpConfigs(workspacePath))

  // pi's MCP brings its own tools but no `/` commands, so config writes leave
  // the command cache alone. The migration is the exception: removing the
  // adapter's config is half of removing its commands.
  handle('mcp:upsertServer', (_event, scope, workspacePath, name, config) =>
    upsertMcpServer(scope, workspacePath, name, config),
  )

  handle('mcp:removeServer', (_event, scope, workspacePath, name) =>
    removeMcpServer(scope, workspacePath, name),
  )

  handle('mcp:setEnabled', (_event, scope, workspacePath, name, enabled) =>
    setMcpServerEnabled(scope, workspacePath, name, enabled),
  )

  handle('mcp:readFile', (_event, scope, workspacePath) => readMcpFile(scope, workspacePath))

  handle('mcp:writeFile', (_event, scope, workspacePath, content) =>
    writeMcpFile(scope, workspacePath, content),
  )

  handle('mcp:list', async (_event, workspacePath) => {
    const cli = await piCli(workspacePath)
    if (!cli) return { ok: false as const, message: 'pi is not available.' }
    return listMcpServers(cli)
  })

  handle('mcp:authorize', async (_event, serverName, workspacePath) => {
    const emit = (state: ConnectorAuthState): void =>
      broadcast('mcp:authState', { serverName, state })
    const cli = await piCli(workspacePath)
    if (!cli) {
      emit({ phase: 'failed', message: 'pi is not available.' })
      return
    }
    // Resolves once the flow has started; the rest arrives on mcp:authState.
    void loginMcpServer(cli, serverName, emit)
  })

  handle('mcp:cancelAuth', (_event, serverName) => cancelMcpLogin(serverName))

  handle('mcp:logout', async (_event, serverName, workspacePath) => {
    const cli = await piCli(workspacePath)
    if (!cli) return { ok: false, message: 'pi is not available.' }
    return logoutMcpServer(cli, serverName)
  })

  handle('mcp:migrationPlan', (_event, workspacePath) => planMcpMigration(workspacePath))

  handle('mcp:migrate', async (_event, workspacePath) => {
    const result = await runMcpMigration(workspacePath)
    invalidatePiCommands()
    return result
  })
}
