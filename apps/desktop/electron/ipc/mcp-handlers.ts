import { handle } from './handle'
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
  authorizeMcpServer,
  logoutMcpServer,
} from '../pi/mcp-actions'
import { broadcast } from '../broadcast'
import { invalidatePiCommands } from '../pi/catalogue'

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

  handle('mcp:list', (_event, workspacePath) => listMcpServers(workspacePath))

  handle('mcp:authorize', (_event, serverName, workspacePath) =>
    authorizeMcpServer(serverName, workspacePath, (state) =>
      broadcast('mcp:authState', { serverName, state }),
    ),
  )

  handle('mcp:cancelAuth', (_event, serverName) => cancelMcpLogin(serverName))

  handle('mcp:logout', (_event, serverName, workspacePath) =>
    logoutMcpServer(serverName, workspacePath),
  )

  handle('mcp:migrationPlan', (_event, workspacePath) => planMcpMigration(workspacePath))

  handle('mcp:migrate', async (_event, workspacePath) => {
    const result = await runMcpMigration(workspacePath)
    invalidatePiCommands()
    return result
  })
}
