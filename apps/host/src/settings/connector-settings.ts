import { join } from 'node:path'
import type { MachineSettings, MachineSettingsChange } from '@phosphor/shared/machine-settings'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import { mcpNamespace } from '@phosphor/shared/mcp'
import { readMcpConfigs, serverProblem } from '@phosphor/session-runtime/pi/mcp-config'
import type { SettingsContext } from './context'
import { saveSettingsFile, settingsFile, SettingsFailure, withSettingsFileLock } from './files'

type ConnectorChange = Extract<MachineSettingsChange, { type: `mcp.${string}` }>

export async function readConnectorSettings(
  state: SettingsContext,
  revision: string,
  repositoryId?: string,
  cwd?: string,
): Promise<Pick<MachineSettings, 'connectors'>> {
  const configs = await readMcpConfigs(cwd, state.dirs)
  const previous = state.connectorChecks.get(repositoryId ?? '')
  const checked =
    previous?.revision === revision && Date.now() - previous.at < 60_000 ? previous : undefined
  return {
    connectors: {
      ...(checked ? { checkedAt: checked.at } : {}),
      servers: configs.servers.map((server) => ({
        name: server.name,
        scope: server.scope,
        transport: server.config.url ? 'https' : 'stdio',
        enabled: server.config.enabled !== false,
        exposure: server.config.exposure ?? 'codemode',
        ...(checked?.servers.get(server.name) ?? {}),
      })),
      ...(configs.projectTrust?.trusted === false
        ? {
            inactiveNames: (
              configs.files.find((file) => file.scope === 'project')?.serverNames ?? []
            )
              .filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))
              .slice(0, 128),
          }
        : {}),
      trusted: configs.projectTrust?.trusted ?? null,
      legacy: configs.legacy,
      malformed: configs.files.some((file) => file.malformed) || configs.errors.length > 0,
    },
  }
}

function updateServers(
  servers: Record<string, unknown>,
  change: ConnectorChange,
  before: MachineSettings,
  cwd?: string,
) {
  if (change.type === 'mcp.upsert') {
    if (Object.keys(servers).length >= 128 || (before.connectors?.servers.length ?? 0) >= 128)
      throw new SettingsFailure(
        'bad-request',
        'This settings page supports at most 128 connectors per scope.',
      )
    if (
      before.connectors?.servers.some(
        (server) =>
          server.name !== change.name && mcpNamespace(server.name) === mcpNamespace(change.name),
      )
    )
      throw new SettingsFailure('bad-request', 'Connector names cannot share a tool namespace.')
    if (
      serverProblem(change.name, change.config, cwd ? 'project' : 'global') ||
      (change.config.url && change.config.command)
    )
      throw new SettingsFailure('bad-request', 'Invalid MCP server configuration.')
    if (Object.hasOwn(servers, change.name))
      throw new SettingsFailure(
        'bad-request',
        'This connector already exists. Remove it explicitly before replacing its configuration.',
      )
    Object.defineProperty(servers, change.name, {
      value: change.config,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  } else if (change.type === 'mcp.remove') delete servers[change.name]
  else {
    const existing = Object.hasOwn(servers, change.name) ? servers[change.name] : undefined
    if (
      existing === undefined &&
      !before.connectors?.servers.some((server) => server.name === change.name)
    )
      throw new SettingsFailure('bad-request', 'Unknown connector.')
    if (existing !== undefined && !machineRecord(existing))
      throw new SettingsFailure('bad-request', 'Invalid MCP entry.')
    servers[change.name] = {
      ...(existing as Record<string, unknown> | undefined),
      enabled: change.enabled,
    }
  }
}

export async function changeConnectorSettings(
  state: SettingsContext,
  change: ConnectorChange,
  before: MachineSettings,
  cwd: string | undefined,
  revision: string,
  commitAllowed: () => boolean,
) {
  if (before.connectors?.legacy)
    throw new SettingsFailure(
      'bad-request',
      'Migrate pi-mcp-adapter on this Host before changing connectors.',
    )
  const path = cwd ? join(cwd, '.pi', 'mcp.json') : join(state.agentDir, 'mcp.json')
  await withSettingsFileLock(path, async () => {
    if (state.revision('connectors', cwd) !== revision)
      throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
    const file = settingsFile(path)
    if (file.raw.mcpServers !== undefined && !machineRecord(file.raw.mcpServers))
      throw new SettingsFailure('bad-request', 'Invalid MCP file. Nothing was overwritten.')
    const servers: Record<string, unknown> = Object.assign(
      Object.create(null),
      machineRecord(file.raw.mcpServers) ? file.raw.mcpServers : {},
    )
    updateServers(servers, change, before, cwd)
    state.invalidateConnectors()
    await saveSettingsFile(path, { ...file.raw, mcpServers: servers }, file.revision, commitAllowed)
  })
}
