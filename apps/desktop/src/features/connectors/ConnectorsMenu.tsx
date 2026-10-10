import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { directToolsSummary, type McpResolvedServer } from '@shared/mcp'
import { ipcErrorText } from '@shared/errors'
import { PopupMenu } from '@/components/PopupMenu'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'

/**
 * Which MCP servers the next lane loads, from the home composer.
 *
 * The same `disabled` flag as Settings → Connectors' "enabled" checkbox,
 * written to the server's own config file, so it sticks. pi-mcp-adapter reads
 * its config when a lane starts, which is why this lives on the new-lane
 * composer: a running lane keeps the servers it started with. A disabled
 * server is not loaded at all, so the `mcp` tool's search and its description
 * only cover what is left.
 */
export function ConnectorsMenu({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element | null {
  const [servers, setServers] = useState<McpResolvedServer[] | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const configs = await window.phosphor.invoke('mcp:readConfigs', workspacePath)
      setServers(configs.servers)
    } catch {
      // No adapter config, or an unreadable one: Settings is where that is fixed.
      setServers([])
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!servers || servers.length === 0) return null
  const enabled = servers.filter((server) => server.config.disabled !== true).length

  const toggle = async (server: McpResolvedServer, on: boolean): Promise<void> => {
    setError(null)
    try {
      await window.phosphor.invoke('mcp:setDisabled', server.scope, workspacePath, server.name, !on)
    } catch (err) {
      setError(ipcErrorText(err))
    }
    await refresh()
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!open) void refresh()
          setOpen((current) => !current)
        }}
        aria-expanded={open}
        title="Connectors: choose which MCP servers new lanes load"
        className={clsx(
          'flex min-h-8 items-center gap-1 rounded-md px-1.5 py-1 text-base transition-colors',
          open
            ? 'bg-bg-secondary text-text'
            : 'text-text-secondary hover:bg-bg-secondary hover:text-text',
        )}
      >
        MCP {enabled}/{servers.length}
      </button>
      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fitViewport
          className="absolute bottom-full left-0 mb-2 w-72 py-1"
        >
          <div className="text-text-tertiary px-3 pt-1.5 pb-1 text-sm">
            New lanes load the checked servers
          </div>
          <div className="max-h-72 overflow-y-auto">
            {servers.map((server) => {
              const direct = directToolsSummary(server.config.directTools)
              return (
                <label
                  key={server.name}
                  className="hover:bg-bg-secondary flex cursor-pointer items-center gap-2 px-3 py-1.5 text-base"
                >
                  <input
                    type="checkbox"
                    checked={server.config.disabled !== true}
                    onChange={(event) => void toggle(server, event.target.checked)}
                    className="accent-[var(--px-accent)]"
                  />
                  <span className="text-text min-w-0 flex-1 truncate font-mono">{server.name}</span>
                  {direct && (
                    <span
                      className="text-warning shrink-0 text-sm"
                      title={`directTools (${direct}): these tools skip the mcp gateway and cost their full schema on every request. Change it in Settings → Connectors.`}
                    >
                      direct
                    </span>
                  )}
                </label>
              )
            })}
          </div>
          {error && <div className="text-danger px-3 py-1 text-sm">{error}</div>}
          <div className="border-border mt-1 border-t px-3 pt-1.5 pb-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                const settings = useSettingsUiStore.getState()
                settings.setTab('connectors')
                settings.setOpen(true)
              }}
              className="text-text-secondary hover:text-text text-sm"
            >
              Manage connectors…
            </button>
          </div>
        </PopupMenu>
      )}
    </div>
  )
}
