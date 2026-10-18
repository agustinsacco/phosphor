import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'

/** Long enough to read and act on; it comes back every launch until the move is done. */
const NOTICE_MS = 15_000

/**
 * Once per launch, while pi-mcp-adapter is still set up: say that Phosphor
 * now manages pi's built-in MCP, and offer the way to Settings → Connectors,
 * where the move is previewed and run. Nothing moves from here.
 *
 * Global config only, which is where the adapter turns pi's MCP off; a
 * project's own adapter file is offered from Connectors in that project.
 */
export async function noticeMcpMigration(): Promise<void> {
  const configs = await window.phosphor.invoke('mcp:readConfigs', undefined).catch(() => null)
  if (!configs?.legacy) return
  useExtensionUiStore.getState().notify({
    kind: 'warning',
    title: 'Move your MCP connectors',
    message:
      'Phosphor now uses pi’s built-in MCP. Your servers still run through pi-mcp-adapter, ' +
      'which Phosphor no longer manages.',
    openLabel: 'Open Connectors',
    durationMs: NOTICE_MS,
    onOpen: () => {
      const settings = useSettingsUiStore.getState()
      settings.setTab('connectors')
      settings.setOpen(true)
    },
  })
}
