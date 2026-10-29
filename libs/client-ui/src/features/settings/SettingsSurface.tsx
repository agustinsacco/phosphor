import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useFindTarget } from '@/components/search/findTargets'
import { FeedbackButton } from '@/features/feedback/FeedbackButton'
import { confirmSettingsNavigation } from '@/features/machines/machineSettingsDrafts'
import { usePlatform } from '@/platform/Platform'
import {
  installedExtensionTabs,
  platformIndex,
  resolveTab,
  visibleSections,
  type EXTENSION_TABS,
} from './settingsIndex'
import { highlightPattern } from './settingsQuery'
import { revealSetting, usePaintMatches } from './settingsHighlight'
import { SettingsSearchField, SettingsSearchResults, useSettingsSearch } from './SettingsSearch'
import { useSettingsMachine, useSettingsWorkspace } from './SettingsMachineScope'
import { SettingsNav } from './SettingsNav'
import { SettingsPanel } from './SettingsPanel'
import { useSettingsUiStore, type SettingsMachine, type SettingsTab } from './settingsUiStore'

/**
 * Settings in every shell: search, the section navigation and the open
 * section. Sections are listed by platform capability alone; frames (the
 * Desktop modal, the browser page) add only their own chrome.
 */
export function SettingsSurface({
  title,
  fallbackMachine,
  asideClassName,
}: {
  /** Shown above the search field when the frame has no title of its own. */
  title?: string
  /** The machine to configure when nothing else picks one (the page's machine). */
  fallbackMachine?: string
  asideClassName?: string
}): React.JSX.Element {
  const platform = usePlatform()
  const tab = useSettingsUiStore((s) => s.tab)
  const { choices, machine } = useSettingsMachine(fallbackMachine)
  const kind = machine ? (machine.id === 'local' ? 'local' : 'host') : null
  const extensionTabs = useExtensionTabs(kind === 'local')
  const sections = useMemo(() => visibleSections(platform, kind), [platform, kind])
  const listed = useMemo(() => [...sections, ...extensionTabs], [sections, extensionTabs])
  const available = useMemo(() => new Set(listed.map((t) => t.id)), [listed])
  const index = useMemo(() => platformIndex(platform), [platform])
  const search = useSettingsSearch(available, index)
  const { query, listing, counts } = search
  const effectiveTab = resolveTab(tab, listed)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const onKeyDown = useSearchShortcut(rootRef, inputRef)
  const panelRef = usePanelFollowsTab(`${machine?.id}/${effectiveTab}`, listing, query)

  const go = guardHostDrafts(kind === 'host' ? (machine?.id ?? null) : null)

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden md:flex-row"
    >
      <aside
        className={clsx(
          'border-border bg-bg-secondary/50 flex shrink-0 flex-col gap-2 border-b px-3 py-3 md:w-52 md:border-b-0 md:border-r md:py-4 md:pr-3',
          asideClassName,
        )}
      >
        {title && (
          <div className="text-text-tertiary hidden px-2 font-mono text-sm font-semibold uppercase tracking-wider md:block">
            {title}
          </div>
        )}
        <SettingsSearchField search={search} inputRef={inputRef} />
        <SettingsNav
          sections={sections}
          nested={extensionTabs}
          selected={listing ? null : effectiveTab}
          counts={counts}
          choices={choices}
          machine={machine}
          onTab={(next: SettingsTab) => go(() => useSettingsUiStore.getState().setTab(next))}
          onMachine={(next: SettingsMachine) =>
            go(() => useSettingsUiStore.getState().setMachine(next))
          }
        />
        {platform.feedback && (
          <div className="border-border mt-auto border-t px-2 pt-3" data-testid="settings-footer">
            <FeedbackButton />
          </div>
        )}
      </aside>
      <div
        ref={panelRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-7 md:py-6"
      >
        {listing ? (
          <SettingsSearchResults search={search} />
        ) : (
          <SettingsPanel tab={effectiveTab} machine={machine} />
        )}
      </div>
    </div>
  )
}

/**
 * Leaving a Host section asks about its unsaved draft first, as the Machines
 * page does. A failed prompt stays put, which keeps the draft.
 */
function guardHostDrafts(hostId: string | null): (next: () => void) => void {
  return (next) => {
    if (!hostId) return next()
    confirmSettingsNavigation(hostId)
      .then((ok) => ok && next())
      .catch(() => undefined)
  }
}

/**
 * The panel starts at the top for each section, scrolls to a chosen search
 * result and paints the query over an open section; results carry their own marks.
 */
function usePanelFollowsTab(
  section: string,
  listing: boolean,
  query: string,
): React.RefObject<HTMLDivElement | null> {
  const reveal = useSettingsUiStore((s) => s.reveal)
  const panelRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    panelRef.current?.scrollTo({ top: 0 })
  }, [section, listing])
  useEffect(() => {
    const panel = panelRef.current
    if (reveal && panel && !listing) return revealSetting(panel, reveal.title)
  }, [reveal, listing, section])
  const paintPattern = useMemo(() => (listing ? null : highlightPattern(query)), [listing, query])
  usePaintMatches(panelRef, paintPattern)
  return panelRef
}

/**
 * This Mac's installed extension tabs, read again whenever the tab changes:
 * installing from the Extensions tab should show the package's own tab
 * without reopening Settings. Hosts list none.
 */
function useExtensionTabs(local: boolean): typeof EXTENSION_TABS {
  const tab = useSettingsUiStore((s) => s.tab)
  const workspace = useSettingsWorkspace()
  const [tabs, setTabs] = useState<typeof EXTENSION_TABS>([])
  useEffect(() => {
    if (!local) return
    let cancelled = false
    void window.phosphor
      .invoke('packages:list', workspace ?? undefined)
      .then((entries) => {
        if (!cancelled) setTabs(installedExtensionTabs(entries))
      })
      .catch(() => {
        if (!cancelled) setTabs([])
      })
    return () => {
      cancelled = true
    }
  }, [local, tab, workspace])
  return local ? tabs : []
}

/**
 * ⌘F anywhere in settings goes to its search field. Covers focus on nothing in
 * particular; the returned handler covers the fields, which the global
 * shortcut handler leaves alone.
 */
function useSearchShortcut(
  rootRef: React.RefObject<HTMLDivElement | null>,
  inputRef: React.RefObject<HTMLInputElement | null>,
): (event: React.KeyboardEvent) => void {
  const focusSearch = (): void => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }
  useFindTarget(rootRef, focusSearch)
  return (event) => {
    const target = event.target as HTMLElement
    if (event.defaultPrevented || target.closest('.monaco-editor')) return
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.code === 'KeyF') {
      event.preventDefault()
      event.stopPropagation()
      focusSearch()
    }
  }
}
