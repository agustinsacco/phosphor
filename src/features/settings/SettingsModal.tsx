import { Fragment, useEffect, useState } from 'react'
import clsx from 'clsx'
import { ModalOverlay } from '@/components/Modal'
import { CloseIcon } from '@/components/icons'
import { useSettingsUiStore, type SettingsTab } from './settingsUiStore'
import { AppearanceTab } from './tabs/AppearanceTab'
import { AgentTab } from './tabs/AgentTab'
import { AccountsTab } from './tabs/AccountsTab'
import { ExtensionsTab } from './tabs/ExtensionsTab'
import { ClaudeProviderTab } from './tabs/ClaudeProviderTab'
import { WebAccessTab } from './tabs/WebAccessTab'
import { WorkspacesTab } from './tabs/WorkspacesTab'
import { AdvancedTab } from './tabs/AdvancedTab'
import { ConnectorsTab } from './tabs/ConnectorsTab'
import { ComputerUseTab } from './tabs/ComputerUseTab'
import { KeybindingsTab } from './tabs/KeybindingsTab'
import { AboutTab } from './tabs/AboutTab'

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'agent', label: 'Agent' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'connectors', label: 'MCP Connectors' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'keybindings', label: 'Keybindings' },
  { id: 'about', label: 'About' },
]

/**
 * Curated extensions contribute a tab only while their package is present.
 * They render nested under the Extensions entry in the sidebar — they are
 * configuration for an installed package, not top-level settings.
 */
const EXTENSION_TABS: Array<{ id: SettingsTab; label: string; packageMatch: string }> = [
  { id: 'claude-provider', label: 'Claude Code', packageMatch: 'pi-claude-cli' },
  { id: 'web-access', label: 'Web access', packageMatch: 'pi-web-access' },
  { id: 'computer-use', label: 'Computer use', packageMatch: '@injaneity/pi-computer-use' },
]

const isExtensionTab = (id: SettingsTab): boolean => EXTENSION_TABS.some((t) => t.id === id)

/** Settings modal shell: sidebar tab list plus the active tab's panel. */
export function SettingsModal(): React.JSX.Element | null {
  const open = useSettingsUiStore((s) => s.open)
  const tab = useSettingsUiStore((s) => s.tab)
  const [installedSpecs, setInstalledSpecs] = useState<string[]>([])

  // Refresh on every open: installing from the Extensions tab should make
  // the extension's own tab appear without reopening the app.
  useEffect(() => {
    if (!open) return
    void window.phosphor
      .invoke('packages:list')
      .then((entries) => setInstalledSpecs(entries.map((e) => e.spec)))
      .catch(() => setInstalledSpecs([]))
  }, [open, tab])

  if (!open) return null
  const close = (): void => useSettingsUiStore.getState().setOpen(false)

  const extensionTabs = EXTENSION_TABS.filter((t) =>
    installedSpecs.some((spec) => spec.includes(t.packageMatch)),
  )

  // Stale sub-tab (e.g. the package was removed out-of-band) falls back to
  // the Extensions list, so the panel never renders an orphaned sub-tab.
  const effectiveTab: SettingsTab =
    isExtensionTab(tab) && !extensionTabs.some((t) => t.id === tab) ? 'extensions' : tab

  return (
    <ModalOverlay onClose={close} z={40}>
      <div className="border-border bg-bg flex h-[78vh] w-[880px] max-w-[94vw] overflow-hidden rounded-2xl border shadow-2xl">
        <aside className="border-border bg-bg-secondary/50 w-52 shrink-0 border-r px-3 py-4">
          <div className="text-text-tertiary px-2 pb-2 text-sm font-semibold font-mono uppercase tracking-wider">
            Settings
          </div>
          {TABS.filter((t) => t.id !== 'connectors').map((t) => (
            <Fragment key={t.id}>
              <button
                onClick={() => useSettingsUiStore.getState().setTab(t.id)}
                className={clsx(
                  'mb-0.5 flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-lg transition-colors',
                  effectiveTab === t.id || (t.id === 'extensions' && isExtensionTab(effectiveTab))
                    ? 'bg-bg-secondary text-text font-medium'
                    : 'text-text-secondary hover:text-text',
                )}
              >
                {t.label}
              </button>
              {t.id === 'extensions' && (
                <>
                  {extensionTabs.map((et) => (
                    <button
                      key={et.id}
                      onClick={() => useSettingsUiStore.getState().setTab(et.id)}
                      className={clsx(
                        'mb-0.5 ml-4 flex w-[calc(100%-1rem)] items-center border-l border-border py-1 pl-3 text-left text-base transition-colors',
                        effectiveTab === et.id
                          ? 'text-text font-medium'
                          : 'text-text-secondary hover:text-text',
                      )}
                    >
                      {et.label}
                    </button>
                  ))}
                  <button
                    key="connectors"
                    onClick={() => useSettingsUiStore.getState().setTab('connectors')}
                    className={clsx(
                      'mb-0.5 ml-4 flex w-[calc(100%-1rem)] items-center border-l border-border py-1 pl-3 text-left text-base transition-colors',
                      effectiveTab === 'connectors'
                        ? 'text-text font-medium'
                        : 'text-text-secondary hover:text-text',
                    )}
                  >
                    MCP Connectors
                  </button>
                </>
              )}
            </Fragment>
          ))}
        </aside>

        <div className="relative min-w-0 flex-1 overflow-y-auto px-7 py-6">
          <button
            onClick={close}
            className="text-text-tertiary hover:text-text absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          >
            <CloseIcon size={14} />
          </button>
          {effectiveTab === 'appearance' && <AppearanceTab />}
          {effectiveTab === 'agent' && <AgentTab />}
          {effectiveTab === 'accounts' && <AccountsTab />}
          {effectiveTab === 'extensions' && <ExtensionsTab />}
          {effectiveTab === 'claude-provider' && <ClaudeProviderTab />}
          {effectiveTab === 'web-access' && <WebAccessTab />}
          {effectiveTab === 'connectors' && <ConnectorsTab />}
          {effectiveTab === 'computer-use' && <ComputerUseTab />}
          {effectiveTab === 'workspaces' && <WorkspacesTab />}
          {effectiveTab === 'advanced' && <AdvancedTab />}
          {effectiveTab === 'keybindings' && <KeybindingsTab />}
          {effectiveTab === 'about' && <AboutTab />}
        </div>
      </div>
    </ModalOverlay>
  )
}
