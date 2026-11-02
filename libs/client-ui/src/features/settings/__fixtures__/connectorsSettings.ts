import { vi } from 'vitest'
import type { McpConfigsResult, McpResolvedServer, McpServerConfig } from '@shared/mcp'
import type { McpCheckSnapshot } from '@shared/mcp-inspection'
import type { MachineSettings } from '@shared/machine-settings'

/** A global server as pi resolves it on This Mac. */
export function globalServer(name: string, config: McpServerConfig): McpResolvedServer {
  return { name, scope: 'global', config, defined: config }
}

/** `mcp:readConfigs` for This Mac with these servers and no problems. */
export function localConfigs(servers: McpResolvedServer[]): McpConfigsResult {
  return { servers, files: [], errors: [], projectTrust: null, legacy: false }
}

/** A finished inspection that found the server up with one tool. */
export function connectedSnapshot(name: string): McpCheckSnapshot {
  const tools = [{ name: 'search', exposure: 'codemode' as const }]
  return { checkedAt: 1, discoveredAt: 1, report: { name, state: 'connected', tools }, tools }
}

/**
 * This Mac's MCP channels over `servers`. Writes succeed and change nothing;
 * every server checks as connected. Unknown channels resolve undefined.
 */
export function localConnectorsInvoke(servers: () => McpResolvedServer[]) {
  return vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    switch (channel) {
      case 'mcp:readConfigs':
        return localConfigs(servers())
      case 'packages:list':
        return []
      case 'mcp:readChecks':
        return {}
      case 'mcp:checkServer':
        return { ok: true, snapshot: connectedSnapshot(args[0] as string) }
      default:
        return undefined
    }
  })
}

type HostServer = NonNullable<MachineSettings['connectors']>['servers'][number]

/** A Host's connectors read with these servers, at machine or folder scope. */
export function hostConnectors(
  servers: HostServer[],
  repositoryId?: string,
  extra: Partial<NonNullable<MachineSettings['connectors']>> = {},
): MachineSettings {
  return {
    section: 'connectors',
    revision: '1'.padStart(64, '0'),
    ...(repositoryId ? { repositoryId } : {}),
    connectors: {
      servers,
      trusted: repositoryId ? true : null,
      legacy: false,
      malformed: false,
      ...extra,
    },
  }
}
