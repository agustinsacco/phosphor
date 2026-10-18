import { useCallback, useEffect, useState } from 'react'
import type { McpResolvedServer } from '@shared/mcp'
import { ipcErrorText } from '@shared/errors'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'

export interface McpServersState {
  /** Null until the first read; empty when nothing is configured or readable. */
  servers: McpResolvedServer[] | null
  enabled: number
  error: string | null
  refresh: () => Promise<void>
  setEnabled: (server: McpResolvedServer, on: boolean) => Promise<void>
}

/**
 * The MCP servers configured for a workspace and their `enabled` flag.
 *
 * The same flag as Settings → Connectors' "enabled" checkbox, written to the
 * file that decides it, so it sticks. pi reads its MCP config when a lane
 * starts; a running lane picks a change up before its next turn.
 */
export function useMcpServers(workspacePath: string): McpServersState {
  const [servers, setServers] = useState<McpResolvedServer[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const configs = await window.phosphor.invoke('mcp:readConfigs', workspacePath)
      setServers(configs.servers)
    } catch {
      // An unreadable config: Settings is where that is fixed.
      setServers([])
    }
  }, [workspacePath])

  // Settings → Connectors writes the same files; re-read once it closes.
  const settingsOpen = useSettingsUiStore((s) => s.open)
  useEffect(() => {
    if (!settingsOpen) void refresh()
  }, [refresh, settingsOpen])

  const setEnabled = async (server: McpResolvedServer, on: boolean): Promise<void> => {
    setError(null)
    try {
      await window.phosphor.invoke(
        'mcp:setEnabled',
        // An override decides enabled for this project, so it is changed there.
        server.overridden ? 'project' : server.scope,
        workspacePath,
        server.name,
        on,
      )
    } catch (err) {
      setError(ipcErrorText(err))
    }
    await refresh()
  }

  const enabled = servers?.filter((server) => server.config.enabled !== false).length ?? 0
  return { servers, enabled, error, refresh, setEnabled }
}
