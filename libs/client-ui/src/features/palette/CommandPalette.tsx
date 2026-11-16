import { useNavigationHostId, useRemoteLanesStore } from '@/stores/remoteLanes'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { openRemoteComposer } from '@/features/home/remoteComposer'
import { useEffect, useMemo, useState } from 'react'
import { fuzzyFilter } from '@/lib/fuzzy'
import { PaletteDialog } from '@/components/PaletteDialog'
import { useLayoutStore } from '@/stores/layout'
import { openMachinePage } from '@/stores/machinePages'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { openSettings } from '@/features/settings/useOpenSettings'
import { navigateDesktop } from '@/navigation/desktopNavigation'
import { useFeedbackStore } from '@/features/feedback/feedbackStore'
import { useFinderStore } from '@/features/files/FuzzyFinder'
import { useChatUiStore } from '@/features/chat/uiState'
import { sessionTitle } from '@/lib/sessionTitle'
import { formatShortcut } from '@/lib/shortcuts'
import { ignoreShortcut, shortcutOverlayOpen } from '@/lib/shortcutContext'

import { usePlatform, type Platform } from '@/platform/Platform'
import { useNavigation } from '@/navigation/Navigation'
import { locationMachine } from '@/navigation/location'
import { browserPaletteActions } from './browserPaletteActions'
import { hostPaletteActions } from './hostPaletteActions'
import { usePaletteStore, type PaletteAction } from './paletteStore'
export { usePaletteStore } from './paletteStore'

/** Actions that act on This Mac only, left out on a Host. */
const LOCAL_ONLY = new Set(['open-folder', 'rewind'])

/**
 * Whether the palette lists an action. The finder mounts only with a folder open, as ⌘P
 * checks, so Go to file needs one.
 */
const listed = (
  action: PaletteAction,
  workspacePath: string,
  remote: boolean,
  platform: Platform,
): boolean => {
  if (remote && LOCAL_ONLY.has(action.id)) return false
  if (action.id === 'feedback') return platform.feedback
  if (action.id === 'keybindings') return platform.appShortcuts
  if (action.id.startsWith('theme-')) return true
  if (action.id.startsWith('toggle-') && action.id !== 'toggle-verbose') return platform.splitPanes
  if (action.id === 'go-to-file') return platform.nativeFiles && workspacePath !== ''
  // The remaining entries use Desktop's workspace/session or native page navigation.
  return platform.localLanes
}

export function CommandPalette({
  workspacePath,
  keyboardShortcut = true,
}: {
  workspacePath: string
  keyboardShortcut?: boolean
}): React.JSX.Element | null {
  const platform = usePlatform()
  const { location, navigate } = useNavigation()
  const machine = locationMachine(location)
  const open = usePaletteStore((s) => s.open)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const hostId = useNavigationHostId()
  const remote = workspacePath.startsWith('host:') || hostId !== undefined
  const disk = useSessionsStore((s) => (open && !remote ? s.disk[workspacePath] : undefined))
  const host = useRemoteLanesStore((s) => (open && hostId ? s.hosts[hostId] : undefined))
  const hosts = useRemoteLanesStore((s) => (open && !platform.localLanes ? s.hosts : undefined))
  const [query, setQuery] = useState('')
  const [addingFolder, setAddingFolder] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!keyboardShortcut || (!platform.appShortcuts && !event.cancelable)) return
      if (ignoreShortcut(event) || shortcutOverlayOpen('palette')) return
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.code === 'KeyK'
      ) {
        event.preventDefault()
        usePaletteStore.getState().setOpen(!usePaletteStore.getState().open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboardShortcut, platform.appShortcuts])

  useEffect(() => {
    if (open) {
      setQuery('')
    }
  }, [open])

  const actions = useMemo<PaletteAction[]>(() => {
    if (!open) return []
    const layout = useLayoutStore.getState()

    const base: PaletteAction[] = [
      {
        id: 'new-session',
        label: 'New session',
        hint: formatShortcut('mod', 'N'),
        run: () => useSessionsStore.getState().activate(null),
      },
      {
        id: 'go-to-file',
        label: 'Go to file…',
        hint: formatShortcut('mod', 'P'),
        run: () => useFinderStore.getState().setOpen(true),
      },
      {
        id: 'toggle-sidebar',
        label: 'Toggle sidebar',
        hint: formatShortcut('mod', 'B'),
        run: () => layout.toggleSidebar(),
      },
      // Global pages, deliberately NOT session-gated: they cover the main
      // region on their own and are the whole point of having them. On a Host
      // they open on that Host; elsewhere on the sidebar's machine.
      {
        id: 'open-artifacts-page',
        label: 'Open artifacts page',
        run: () => openMachinePage('artifacts', hostId ?? null),
      },
      {
        id: 'open-skills-page',
        label: 'Open skills page',
        run: () => openMachinePage('skills', hostId ?? null),
      },
      // Right-pane commands only exist inside a session — the pane itself is
      // rendered by MainWithPanes, which requires one. Offering them on the
      // home screen produced a no-op that also desynced the pane state.
      ...(activeSessionId
        ? ([
            {
              id: 'toggle-files',
              label: 'Toggle files pane',
              hint: formatShortcut('mod', 'shift', 'E'),
              run: () => layout.toggleRightPane('files'),
            },
            {
              id: 'toggle-changes',
              label: 'Toggle changes pane',
              hint: formatShortcut('mod', 'shift', 'G'),
              run: () => layout.toggleRightPane('changes'),
            },
            {
              id: 'toggle-terminal',
              label: 'Toggle terminal',
              hint: formatShortcut('mod', '`'),
              run: () => layout.toggleRightPane('terminal'),
            },
            {
              id: 'toggle-artifacts',
              label: 'Toggle artifacts pane',
              run: () => layout.toggleRightPane('artifacts'),
            },
            {
              id: 'toggle-subagents',
              label: 'Toggle subagents pane',
              run: () => layout.toggleRightPane('subagents'),
            },
            {
              id: 'rewind',
              label: 'Rewind to an earlier message…',
              hint: 'Esc Esc',
              run: () => useChatUiStore.getState().openForkPicker(activeSessionId),
            },
            {
              id: 'toggle-verbose',
              label: 'Expand / collapse tool output',
              hint: formatShortcut('ctrl', 'O'),
              run: () => useChatUiStore.getState().toggleVerbose(activeSessionId),
            },
          ] satisfies PaletteAction[])
        : []),
      {
        id: 'settings',
        label: 'Open settings',
        hint: formatShortcut('mod', ','),
        run: () => useSettingsUiStore.getState().setOpen(true),
      },
      {
        id: 'feedback',
        label: 'Send feedback',
        run: () => useFeedbackStore.getState().setOpen(true),
      },
      {
        id: 'keybindings',
        label: 'Keyboard shortcuts',
        hint: formatShortcut('mod', '/'),
        run: () => openSettings((next) => void navigateDesktop(next), null, 'keybindings'),
      },
      {
        id: 'theme-light',
        label: 'Theme: light',
        run: () => useSettingsStore.getState().setTheme('light'),
      },
      {
        id: 'theme-dark',
        label: 'Theme: dark',
        run: () => useSettingsStore.getState().setTheme('dark'),
      },
      {
        id: 'theme-system',
        label: 'Theme: system',
        run: () => useSettingsStore.getState().setTheme('system'),
      },
      {
        id: 'open-folder',
        label: 'Open workspace folder…',
        run: () => void useWorkspacesStore.getState().pickAndOpen(),
      },
    ]

    if (!remote) base.push(...localPaletteActions(workspacePath, disk))

    const shown = base.filter((action) => listed(action, workspacePath, remote, platform))
    if (!platform.localLanes)
      return [...browserPaletteActions(hosts ?? {}, navigate, setAddingFolder, machine), ...shown]
    if (!remote) return shown
    return [...shown, ...(hostId && host ? hostPaletteActions(hostId, host, setAddingFolder) : [])]
  }, [
    workspacePath,
    open,
    activeSessionId,
    disk,
    host,
    hostId,
    remote,
    platform,
    hosts,
    navigate,
    machine,
  ])

  const matches = useMemo(
    () => fuzzyFilter(query, actions, (a) => `${a.label} ${a.hint ?? ''}`, 12),
    [query, actions],
  )

  const folderBrowser = addingFolder && (
    <HostFolderBrowser
      hostId={addingFolder}
      onClose={() => setAddingFolder(null)}
      onAdded={(repositoryId) => {
        openRemoteComposer(addingFolder, repositoryId)
        if (!platform.localLanes) navigate({ to: 'new', machine: addingFolder })
      }}
    />
  )
  if (!open) return folderBrowser || null
  const close = (): void => usePaletteStore.getState().setOpen(false)

  const run = (action: PaletteAction): void => {
    close()
    action.run()
  }

  return (
    <>
      <PaletteDialog
        query={query}
        onQuery={setQuery}
        matches={matches}
        onRun={run}
        onClose={close}
      />
      {folderBrowser}
    </>
  )
}

/** All scanned sessions are searchable; only the match renderer is bounded. */
function localPaletteActions(
  workspacePath: string,
  disk: ReturnType<typeof useSessionsStore.getState>['disk'][string] | undefined,
): PaletteAction[] {
  const base: PaletteAction[] = []
  const recents = useWorkspacesStore.getState().recents
  for (const workspace of recents.filter((w) => w.path !== workspacePath).slice(0, 5)) {
    base.push({
      id: `ws-${workspace.path}`,
      label: `Switch workspace: ${workspace.name}`,
      hint: workspace.path,
      run: () => {
        useWorkspacesStore.getState().openWorkspace(workspace.path)
        useSessionsStore.getState().activate(null)
      },
    })
  }

  for (const meta of disk ?? []) {
    base.push({
      id: `session-${meta.path}`,
      label: `Open session: ${
        sessionTitle({ explicitName: meta.name, firstUserText: meta.firstUserText }) ?? 'Untitled'
      }`,
      run: () => void useSessionsStore.getState().openDiskSession(workspacePath, meta),
    })
  }

  return base
}
