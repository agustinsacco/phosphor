import {
  machineLabel,
  openRemoteLane,
  useNavigationHostId,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'
import type { HostConnectionView } from '@shared/ipc'
import { canAddHostFolder, HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { remoteLaneTitle } from '@/features/sessions/remoteLaneView'
import { openRemoteComposer } from '@/features/home/remoteComposer'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { fuzzyFilter } from '@/lib/fuzzy'
import { MenuRow } from '@/components/PopupMenu'
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

interface PaletteState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

interface PaletteAction {
  id: string
  label: string
  hint?: string
  run: () => void
}

/** Actions that act on This Mac only, left out on a Host. */
const LOCAL_ONLY = new Set(['open-folder', 'rewind'])

/**
 * Whether the palette lists an action. The finder mounts only with a folder open, as ⌘P
 * checks, so Go to file needs one.
 */
const listed = (action: PaletteAction, workspacePath: string, remote: boolean): boolean =>
  (action.id !== 'go-to-file' || workspacePath !== '') && !(remote && LOCAL_ONLY.has(action.id))

export function CommandPalette({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element | null {
  const open = usePaletteStore((s) => s.open)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const hostId = useNavigationHostId()
  const remote = workspacePath.startsWith('host:') || hostId !== undefined
  const disk = useSessionsStore((s) => (open && !remote ? s.disk[workspacePath] : undefined))
  const host = useRemoteLanesStore((s) => (open && hostId ? s.hosts[hostId] : undefined))
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const [addingFolder, setAddingFolder] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
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
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  const actions = useMemo<PaletteAction[]>(() => {
    if (!open) return []
    const layout = useLayoutStore.getState()
    const recents = useWorkspacesStore.getState().recents

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

    for (const workspace of (remote ? [] : recents)
      .filter((w) => w.path !== workspacePath)
      .slice(0, 5)) {
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

    for (const meta of (disk ?? []).slice(0, 8)) {
      base.push({
        id: `session-${meta.path}`,
        label: `Open session: ${
          sessionTitle({ explicitName: meta.name, firstUserText: meta.firstUserText }) ?? 'Untitled'
        }`,
        run: () => void useSessionsStore.getState().openDiskSession(workspacePath, meta),
      })
    }

    const shown = base.filter((action) => listed(action, workspacePath, remote))
    if (!remote) return shown
    return [...shown, ...(hostId && host ? hostActions(hostId, host, setAddingFolder) : [])]
  }, [workspacePath, open, activeSessionId, disk, host, hostId, remote])

  const matches = useMemo(() => fuzzyFilter(query, actions, (a) => a.label, 12), [query, actions])

  const folderBrowser = addingFolder && (
    <HostFolderBrowser
      hostId={addingFolder}
      onClose={() => setAddingFolder(null)}
      onAdded={(repositoryId) => openRemoteComposer(addingFolder, repositoryId)}
    />
  )
  if (!open) return folderBrowser || null
  const close = (): void => usePaletteStore.getState().setOpen(false)

  const run = (action: PaletteAction): void => {
    close()
    action.run()
  }

  const palette = createPortal(
    <div
      data-shortcut-overlay="palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[16vh] backdrop-blur-[2px]"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="border-border bg-surface-raised w-[560px] overflow-hidden rounded-xl border shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={(e) => {
            if (ignoreShortcut(e.nativeEvent)) return
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActiveIndex((i) => (i + 1) % Math.max(1, matches.length))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIndex((i) => (i - 1 + matches.length) % Math.max(1, matches.length))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const action = matches[activeIndex]
              if (action) run(action)
            }
          }}
          placeholder="Type a command…"
          className="text-text placeholder:text-text-tertiary border-border block w-full border-b bg-transparent px-4 py-3 text-lg outline-none"
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {matches.map((action, index) => (
            <MenuRow
              key={action.id}
              active={index === activeIndex}
              onHover={() => setActiveIndex(index)}
              onClick={() => run(action)}
            >
              <span className="min-w-0 flex-1 truncate text-lg">{action.label}</span>
              {action.hint && (
                <span className="text-text-tertiary shrink-0 font-mono text-xs">{action.hint}</span>
              )}
            </MenuRow>
          ))}
          {matches.length === 0 && (
            <div className="text-text-tertiary px-4 py-4 text-center text-base">
              No matching commands
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
  return (
    <>
      {palette}
      {folderBrowser}
    </>
  )
}

/**
 * A Host's own entries, standing in for This Mac's workspace ones: its lanes,
 * a new lane in each of its folders ("Switch workspace"), and Add folder on it
 * ("Open workspace folder…") where this device may add one.
 */
function hostActions(
  hostId: string,
  host: HostConnectionView,
  addFolder: (hostId: string) => void,
): PaletteAction[] {
  const lanes = host.lanes.map((lane) => ({
    id: `lane-${lane.laneId}`,
    label: `Open lane: ${remoteLaneTitle(null, lane.title)}`,
    run: () => void openRemoteLane(hostId, lane.laneId),
  }))
  const repositories = host.repositories.map((repository) => ({
    id: `new-lane-${repository.id}`,
    label: `New lane in ${repository.name}`,
    hint: machineLabel(hostId),
    run: () => openRemoteComposer(hostId, repository.id),
  }))
  const add = {
    id: 'add-host-folder',
    label: `Add folder on ${machineLabel(hostId)}…`,
    run: () => addFolder(hostId),
  }
  return [...lanes, ...repositories, ...(canAddHostFolder(host) ? [add] : [])]
}
