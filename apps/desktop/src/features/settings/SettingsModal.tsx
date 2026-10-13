import { TooltipButton } from '@/components/Tooltip'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ModalOverlay } from '@/components/Modal'
import { CloseIcon } from '@/components/icons'
import { useFindTarget } from '@/components/search/findTargets'
import { useSettingsUiStore, type SettingsTab } from './settingsUiStore'
import { EXTENSION_TABS, TABS, installedExtensionTabs } from './settingsIndex'
import { useActiveWorkspace } from '@/stores/workspaces'
import { highlightPattern } from './settingsQuery'
import { revealSetting, usePaintMatches } from './settingsHighlight'
import { SettingsSearchField, SettingsSearchResults, useSettingsSearch } from './SettingsSearch'
import { AppearanceTab } from './tabs/AppearanceTab'
import { AgentTab } from './tabs/AgentTab'
import { AccountsTab } from './tabs/AccountsTab'
import { ExtensionsTab } from './tabs/ExtensionsTab'
import { ClaudeProviderTab } from './tabs/ClaudeProviderTab'
import { WebAccessTab } from './tabs/WebAccessTab'
import { WorkspacesTab } from './tabs/WorkspacesTab'
import { OptimizationTab } from './tabs/OptimizationTab'
import { AdvancedTab } from './tabs/AdvancedTab'
import { VoiceTab } from './tabs/VoiceTab'
import { ConnectorsTab } from './tabs/ConnectorsTab'
import { ComputerUseTab } from './tabs/ComputerUseTab'
import { SubagentsTab } from './tabs/SubagentsTab'
import { KeybindingsTab } from './tabs/KeybindingsTab'
import { AboutTab } from './tabs/AboutTab'
import { FeedbackButton } from '@/features/feedback/FeedbackButton'

const isExtensionTab = (id: SettingsTab): boolean => EXTENSION_TABS.some((t) => t.id === id)

/**
 * Settings modal shell: search and the tab list beside the active tab's panel
 * (above it, as a scrolling strip, on a narrow window).
 */
export function SettingsModal(): React.JSX.Element | null {
  const open = useSettingsUiStore((s) => s.open)
  const tab = useSettingsUiStore((s) => s.tab)
  const reveal = useSettingsUiStore((s) => s.reveal)
  const workspace = useActiveWorkspace()
  const [extensionTabs, setExtensionTabs] = useState<typeof EXTENSION_TABS>([])
  const dialogRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Refresh on every open: installing from the Extensions tab should make
  // the extension's own tab appear without reopening the app.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.phosphor
      .invoke('packages:list', workspace ?? undefined)
      .then((entries) => {
        if (!cancelled) setExtensionTabs(installedExtensionTabs(entries))
      })
      .catch(() => {
        if (!cancelled) setExtensionTabs([])
      })
    return () => {
      cancelled = true
    }
  }, [open, tab, workspace])
  const available = useMemo(
    () => new Set([...TABS, ...extensionTabs].map((t) => t.id)),
    [extensionTabs],
  )
  const search = useSettingsSearch(available)
  const { query, listing, counts } = search

  // Stale sub-tab (e.g. the package was removed out-of-band) falls back to
  // the Extensions list, so the panel never renders an orphaned sub-tab.
  const effectiveTab: SettingsTab =
    isExtensionTab(tab) && !extensionTabs.some((t) => t.id === tab) ? 'extensions' : tab

  // ⌘F anywhere in settings goes to its search field. Covers focus on
  // nothing in particular; `onKeyDown` below covers the fields, which the
  // global shortcut handler leaves alone.
  const focusSearch = (): void => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }
  useFindTarget(dialogRef, focusSearch)
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const target = event.target as HTMLElement
    if (event.defaultPrevented || target.closest('.monaco-editor')) return
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.code === 'KeyF') {
      event.preventDefault()
      event.stopPropagation()
      focusSearch()
    }
  }

  useLayoutEffect(() => {
    panelRef.current?.scrollTo({ top: 0 })
  }, [effectiveTab, listing])
  useEffect(() => {
    const panel = panelRef.current
    if (reveal && panel && !listing) return revealSetting(panel, reveal.title)
  }, [reveal, listing, effectiveTab])
  // Results carry their own marks; an open tab gets the query painted over it.
  const paintPattern = useMemo(() => (listing ? null : highlightPattern(query)), [listing, query])
  usePaintMatches(panelRef, paintPattern)

  if (!open) return null
  const close = (): void => useSettingsUiStore.getState().setOpen(false)
  const navButton = (id: SettingsTab, label: string, nested = false): React.JSX.Element => (
    <NavButton
      key={id}
      label={label}
      nested={nested}
      selected={
        !listing && (effectiveTab === id || (id === 'extensions' && isExtensionTab(effectiveTab)))
      }
      count={counts ? (counts.get(id) ?? 0) : null}
      onClick={() => useSettingsUiStore.getState().setTab(id)}
    />
  )

  return (
    <ModalOverlay onClose={close} z={40}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onKeyDown={onKeyDown}
        className="border-border bg-bg relative flex h-[86vh] w-[880px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border shadow-2xl md:h-[78vh] md:flex-row"
      >
        <aside className="border-border bg-bg-secondary/50 flex shrink-0 flex-col gap-2 border-b px-3 py-3 pr-12 md:w-52 md:border-b-0 md:border-r md:py-4 md:pr-3">
          <div className="text-text-tertiary hidden px-2 text-sm font-semibold font-mono uppercase tracking-wider md:block">
            Settings
          </div>
          <SettingsSearchField search={search} inputRef={inputRef} />
          <nav
            aria-label="Settings sections"
            className="-mx-1 min-h-0 flex gap-0.5 overflow-x-auto px-1 md:mx-0 md:block md:flex-1 md:overflow-y-auto md:px-0"
          >
            {TABS.filter((t) => t.id !== 'connectors').map((t) => (
              <Fragment key={t.id}>
                {navButton(t.id, t.label)}
                {t.id === 'extensions' && (
                  <>
                    {extensionTabs.map((et) => navButton(et.id, et.label, true))}
                    {navButton('connectors', 'MCP Connectors', true)}
                  </>
                )}
              </Fragment>
            ))}
          </nav>
          <div className="border-border mt-auto border-t px-2 pt-3" data-testid="settings-footer">
            <FeedbackButton />
          </div>
        </aside>

        <div
          ref={panelRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-7 md:py-6"
        >
          {listing ? (
            <SettingsSearchResults search={search} />
          ) : (
            <>
              {effectiveTab === 'appearance' && <AppearanceTab />}
              {effectiveTab === 'agent' && <AgentTab />}
              {effectiveTab === 'accounts' && <AccountsTab />}
              {effectiveTab === 'extensions' && <ExtensionsTab />}
              {effectiveTab === 'claude-provider' && <ClaudeProviderTab />}
              {effectiveTab === 'web-access' && <WebAccessTab />}
              {effectiveTab === 'connectors' && <ConnectorsTab />}
              {effectiveTab === 'computer-use' && <ComputerUseTab />}
              {effectiveTab === 'subagents' && <SubagentsTab />}
              {effectiveTab === 'workspaces' && <WorkspacesTab />}
              {effectiveTab === 'optimization' && <OptimizationTab />}
              {effectiveTab === 'voice' && <VoiceTab />}
              {effectiveTab === 'advanced' && <AdvancedTab />}
              {effectiveTab === 'keybindings' && <KeybindingsTab />}
              {effectiveTab === 'about' && <AboutTab />}
            </>
          )}
        </div>

        <TooltipButton
          onClick={close}
          aria-label="Close settings"
          className="text-text-tertiary hover:text-text hover:bg-bg-secondary absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-md transition-colors"
        >
          <CloseIcon size={14} />
        </TooltipButton>
      </div>
    </ModalOverlay>
  )
}

/**
 * One sidebar entry. Nested entries (an extension's own tab) indent under
 * Extensions in the sidebar and sit inline in the narrow strip. While
 * searching, each shows its match count and dims without any.
 */
function NavButton({
  label,
  nested,
  selected,
  count,
  onClick,
}: {
  label: string
  nested: boolean
  selected: boolean
  count: number | null
  onClick: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      className={clsx(
        'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left transition-colors md:mb-0.5',
        nested
          ? 'md:border-border text-base md:ml-4 md:w-[calc(100%-1rem)] md:rounded-none md:border-l md:py-1 md:pl-3'
          : 'text-lg md:w-full',
        selected
          ? clsx('bg-bg-secondary text-text font-medium', nested && 'md:bg-transparent')
          : 'text-text-secondary hover:text-text',
        count === 0 && 'opacity-40',
      )}
    >
      {label}
      {count !== null && count > 0 && (
        <span
          aria-hidden="true"
          className="bg-accent-soft text-accent ml-auto rounded-full px-1.5 text-2xs font-medium tabular-nums"
        >
          {count}
        </span>
      )}
    </TooltipButton>
  )
}
