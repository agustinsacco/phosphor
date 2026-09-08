import { useEffect, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { PiHealth } from '@shared/models'
import { useSettingsStore } from '@/stores/settings'
import { useActiveWorkspace, useWorkspacesStore } from '@/stores/workspaces'
import { useStartingChatStore } from '@/stores/startingChat'
import { useSessionsStore } from '@/stores/sessions'
import { useActivePanes, useLayoutStore } from '@/stores/layout'
import { PiMissingScreen } from './PiMissingScreen'
import { GettingStartedScreen } from './GettingStartedScreen'
import { WorkspacePicker } from './WorkspacePicker'
import { ChatView } from '@/features/chat/ChatView'
import { WorkspaceHome } from '@/features/home/WorkspaceHome'
import { StartingChat } from '@/features/home/StartingChat'
import { Sidebar } from '@/features/sessions/Sidebar'
import { SkillsPage } from '@/features/skills/SkillsPage'
import { ArtifactsPage } from '@/features/artifacts/ArtifactsPage'
import { TopBar } from './TopBar'
import { ContextMenuHost } from '@/components/ContextMenu'
import { RightPane } from '@/features/files/RightPane'
import { FuzzyFinder } from '@/features/files/FuzzyFinder'
import { useGlobalShortcuts } from './useGlobalShortcuts'
import { ExtensionDialogHost, ToastHost } from '@/features/extension-ui/ExtensionUiHosts'
import { PromptHost } from '@/components/PromptHost'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { useTerminalStore } from '@/stores/terminal'
import { attachConnectorAuthListener } from '@/stores/connectors'
import { useWorktreesStore } from '@/stores/worktrees'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { useDraftsStore } from '@/stores/drafts'
import { worktreeAwareName } from '@/lib/path'

export function App(): React.JSX.Element {
  const [health, setHealth] = useState<PiHealth | null>(null)
  const currentWorkspace = useActiveWorkspace()
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const starting = useStartingChatStore((s) => s.starting)
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const page = useLayoutStore((s) => s.page)
  const currentWorkspaceGit = useSessionsStore((s) =>
    currentWorkspace ? s.gitByCwd[currentWorkspace] : undefined,
  )

  const [restoring, setRestoring] = useState(true)
  const [showGettingStarted, setShowGettingStarted] = useState(false)

  useEffect(() => {
    void useSettingsStore.getState().hydrate()
    void useWorkspacesStore.getState().hydrate()
    void useWorktreesStore.getState().hydratePrefs()
    // Preload the model catalogue: it spawns a pi process, so paying for it
    // now means the first picker open is instant instead of showing an empty
    // list that reads as "nothing configured".
    void useModelCatalogueStore.getState().hydrate()
    // Restores unsent drafts (text, pasted images, the model each was
    // composed against) and runs the launch-time draft GC.
    void useDraftsStore.getState().hydrate()
    void window.phosphor.invoke('pi:health').then(setHealth)
  }, [])

  // Terminal busy-map broadcast → store (drives header badges + tab dots).
  useEffect(
    () =>
      window.phosphor.onPtyStatus((statuses) => useTerminalStore.getState().applyStatus(statuses)),
    [],
  )

  // Headless connector authorization runs in main (no session needed), so its
  // progress arrives as a broadcast rather than on a session's channel.
  useEffect(() => attachConnectorAuthListener(), [])

  // Land where the user left off. Main validates that the workspace and
  // session file still exist, so a deleted folder degrades to the picker
  // instead of routing into a broken screen.
  useEffect(() => {
    if (!health?.ok) return
    let cancelled = false

    void (async () => {
      try {
        // Re-adopt live pi subprocesses main still owns before deciding what
        // to open. A renderer reload (HMR, crash, re-navigation) used to
        // orphan every one of them — ~200 MB each, stranded until quit — and
        // resuming a session an orphan still owned would have spawned a
        // SECOND process against the same session file. `adoptSession` learns
        // each one's session file from `get_state`, which is what the resume
        // match below waits on.
        const orphans = await window.phosphor.invoke('pi:listLiveSessions').catch(() => [])
        for (const orphan of orphans) {
          if (cancelled) return
          await useSessionsStore.getState().adoptSession(orphan.sessionId, orphan.workspacePath)
        }

        const target = await window.phosphor.invoke('app:resumeTarget')
        if (cancelled || target.kind === 'none') return

        useWorkspacesStore.getState().openWorkspace(target.workspacePath)
        if (target.kind === 'session' && !cancelled) {
          // An adopted orphan that IS the resume target: activate it rather
          // than spawning a duplicate process on the same file.
          const adopted = Object.values(useSessionsStore.getState().live).find(
            (l) => l.diskPath === target.sessionPath,
          )
          if (adopted) {
            useSessionsStore.getState().activate(adopted.phosphorId)
            return
          }
          // Resume by path directly. The session-dir scan is only used to
          // enrich the sidebar; requiring a match there would fail whenever
          // the file lives outside pi's default session directory.
          await useSessionsStore
            .getState()
            .createSession(target.workspacePath, { sessionPath: target.sessionPath })
        }
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [health?.ok])

  useGlobalShortcuts()

  // Window title: workspace · session.
  useEffect(() => {
    const name = currentWorkspace
      ? worktreeAwareName(currentWorkspace, currentWorkspaceGit)
      : undefined
    document.title = name ? `${name} — Phosphor` : 'Phosphor'
  }, [currentWorkspace, currentWorkspaceGit])

  if (health === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-text-tertiary animate-pulse text-lg">Checking pi installation…</div>
      </div>
    )
  }

  if (!health.ok) {
    return (
      <PiMissingScreen
        health={health}
        onRetry={() => {
          setHealth(null)
          void window.phosphor.invoke('pi:health').then(setHealth)
        }}
        onInstalled={() => setShowGettingStarted(true)}
      />
    )
  }

  // One-time recommendations after Phosphor itself installed pi.
  if (showGettingStarted) {
    return <GettingStartedScreen onDone={() => setShowGettingStarted(false)} />
  }

  // Hold the picker back until the restore attempt settles, otherwise it
  // flashes for a frame before the previous session loads.
  if (!currentWorkspace) {
    if (restoring) {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="text-text-tertiary animate-pulse text-lg">Restoring your session…</div>
        </div>
      )
    }
    return <WorkspacePicker piVersion={health.version} />
  }

  return (
    // Column, not a row: the top bar spans the whole window above the
    // sidebar/chat/pane columns. That is what keeps the OS window-control
    // inset a single concern (see TopBar) instead of something each column
    // that can reach the right edge has to remember.
    <div className="flex h-full flex-col">
      <TopBar workspacePath={currentWorkspace} />
      <div className="flex min-h-0 flex-1">
        {sidebarVisible && <Sidebar workspacePath={currentWorkspace} />}
        <main className="relative min-w-0 flex-1">
          {/*
            Three states, in priority order. `starting` sits between the other
            two on purpose: it covers the window where a chat has been sent but
            `activeSessionId` is still null, which used to fall through to the
            greeting screen — and since `startChat` switches the open workspace
            to the new worktree before the session exists, that greeting
            re-rendered for an empty folder ("Start your first session in
            hey-2") for a beat before the chat replaced it.
          */}
          {activeSessionId ? (
            <MainWithPanes workspacePath={currentWorkspace} activeSessionId={activeSessionId} />
          ) : starting ? (
            <StartingChat starting={starting} />
          ) : (
            <WorkspaceHome workspacePath={currentWorkspace} />
          )}
          {/*
            Global pages cover the main region as an overlay, like an expanded
            pane (z-20 inside MainWithPanes) but one level up and one z higher.
            Overlay rather than a fourth main state so the session underneath
            stays mounted — closing the page returns to the chat exactly as it
            was. Sidebar and top bar stay reachable; session activation closes
            the page (stores/sessions.ts activate).
          */}
          {page && (
            <div data-testid="global-page" className="bg-bg absolute inset-0 z-30">
              {page === 'skills' ? (
                <SkillsPage workspacePath={currentWorkspace} />
              ) : (
                <ArtifactsPage />
              )}
            </div>
          )}
        </main>
      </div>
      <FuzzyFinder workspacePath={currentWorkspace} />
      <ContextMenuHost />
      <ExtensionDialogHost />
      <PromptHost />
      <ToastHost />
      <CommandPalette workspacePath={currentWorkspace} />
      <SettingsModal />
    </div>
  )
}

function MainWithPanes({
  workspacePath,
  activeSessionId,
}: {
  workspacePath: string
  activeSessionId: string
}): React.JSX.Element {
  const { pane: rightPane, expanded, side, size } = useActivePanes()

  // Fullscreen (↗) is an OVERLAY, not a resize. It used to imperatively
  // resize the split to 85/15, which crushed the chat to an unusable column
  // and — because sizes persisted per workspace — leaked the squish into
  // every other session. Now the pane leaves the split and covers the main
  // region; the saved size is never mutated, so exiting restores it exactly.
  const paneInSplit = rightPane !== null && !expanded

  const chatPanel = (
    <Panel id="chat" order={side === 'left' ? 2 : 1} minSize={15}>
      <ChatView key={activeSessionId} sessionId={activeSessionId} workspacePath={workspacePath} />
    </Panel>
  )

  const panePanel = paneInSplit && (
    <Panel
      id="pane"
      order={side === 'left' ? 1 : 2}
      defaultSize={size}
      minSize={24}
      maxSize={85}
      onResize={(next) => useLayoutStore.getState().setPaneSize(next, activeSessionId)}
    >
      <RightPane workspacePath={workspacePath} sessionId={activeSessionId} />
    </Panel>
  )

  return (
    <div className="relative h-full">
      {/*
       * Keyed by session AND side: `defaultSize` only applies when a panel
       * mounts, so re-applying each session's remembered size (and reordering
       * the columns on a side swap) needs a fresh group. Sizes persist in the
       * layout store per session — the old per-workspace autoSaveId made every
       * lane in a workspace fight over one saved size.
       */}
      <PanelGroup key={`${activeSessionId}:${side}`} direction="horizontal">
        {side === 'left' && panePanel}
        {side === 'left' && paneInSplit && <PanelResizeHandle className="pane-handle" />}
        {chatPanel}
        {side === 'right' && paneInSplit && <PanelResizeHandle className="pane-handle" />}
        {side === 'right' && panePanel}
      </PanelGroup>
      {rightPane !== null && expanded && (
        // Opaque backdrop: the pane card keeps its inset gutter, and the chat
        // must not shimmer through it. Sidebar and top bar stay reachable.
        <div className="bg-bg absolute inset-0 z-20">
          <RightPane workspacePath={workspacePath} sessionId={activeSessionId} />
        </div>
      )}
    </div>
  )
}
