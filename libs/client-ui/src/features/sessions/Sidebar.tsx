import { useState } from 'react'
import clsx from 'clsx'
import type { SessionMeta } from '@shared/models'
import { MergeWorktreeModal } from '@/features/worktrees/MergeWorktreeModal'
import { RemoveWorktreeModal } from '@/features/worktrees/RemoveWorktreeModal'
import { toggleDesktopPage } from '@/navigation/desktopNavigation'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { LocalDeleteDialogs } from './LocalBulkDelete'
import type { LocalWorktreeModal } from './LocalFolderMenuRows'
import { SessionRow } from './LocalLaneRow'
import { LocalWorkspaceGroup, useLocalRows } from './LocalWorkspaceGroup'
import { MachineLabelLine } from './MachineSwitcher'
import { RemoteLanes } from './RemoteLanes'
import { SessionList } from './SessionList'
import { SidebarFooter, SidebarNavigation } from './SidebarNavigation'
import { SectionLabel, WorkspaceGroupSkeletons } from './SidebarPrimitives'
import { TreeViewModal } from './TreeViewModal'
import { useLocalSidebarGroups } from './useLocalSidebarGroups'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

const NO_PENDING: readonly string[] = Object.freeze([])

const SIDEBAR_WIDTH_KEY = 'phosphor:sidebarWidth'
const SIDEBAR_MIN = 208
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 256

function loadSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  if (!Number.isFinite(stored) || stored === 0) return SIDEBAR_DEFAULT
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, stored))
}

export function Sidebar({
  workspacePath,
  onInitialReady,
}: {
  workspacePath: string
  onInitialReady?: (ready: boolean) => void
}): React.JSX.Element {
  const machineFilter = useRemoteLanesStore((s) => s.filter)
  const bulkDeleteRunning = useSessionsStore((s) => s.bulkDelete?.running ?? false)
  const [treeFor, setTreeFor] = useState<SessionMeta | null>(null)
  const [worktreeModal, setWorktreeModal] = useState<LocalWorktreeModal | null>(null)
  const [width, setWidth] = useState(loadSidebarWidth)
  const [resizing, setResizing] = useState(false)
  const { ready, collapseLoaded, groups, pinnedMetas, pendingByWorkspace, isGroupCollapsed } =
    useLocalSidebarGroups(workspacePath, onInitialReady)

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    setResizing(true)
    const onMove = (move: PointerEvent): void => {
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + move.clientX - startX))
      setWidth(next)
    }
    const onUp = (up: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setResizing(false)
      const finalWidth = Math.min(
        SIDEBAR_MAX,
        Math.max(SIDEBAR_MIN, startWidth + up.clientX - startX),
      )
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(finalWidth))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const { rowProps } = useLocalRows(workspacePath, setTreeFor)

  const sidebarLoading = !ready

  return (
    <aside className="bg-sidebar relative flex h-full shrink-0 flex-col" style={{ width }}>
      {/* No drag strip here any more: the window's title bar is now a single
          full-width element above every column (src/app/TopBar.tsx), which is
          also where the macOS traffic-light inset lives. */}
      <WorkspaceSwitcher />

      <SidebarNavigation onPage={toggleDesktopPage} />
      <div data-session-scroll className="flex-1 overflow-y-auto px-2 pb-2">
        <div hidden={machineFilter !== 'all' && machineFilter !== 'local'}>
          {machineFilter === 'all' && <MachineLabelLine id="local" />}
          {!sidebarLoading && pinnedMetas.length > 0 && (
            <>
              <SectionLabel>Pinned</SectionLabel>
              <SessionList
                disabled={bulkDeleteRunning}
                items={pinnedMetas.map((meta) => ({
                  id: meta.path,
                  path: meta.path,
                  content: <SessionRow {...rowProps(meta)} isPinned showWorkspace />,
                }))}
              />
            </>
          )}

          {/* Prefs decide both which workspaces exist and what order they sit
            in, so any header painted before they land can be wrong or about
            to jump. A skeleton is the honest answer for that window. */}
          {sidebarLoading && <WorkspaceGroupSkeletons />}

          {!sidebarLoading &&
            collapseLoaded &&
            groups.map((group, index) => (
              <LocalWorkspaceGroup
                key={group.workspacePath}
                group={group}
                first={index === 0}
                last={index === groups.length - 1}
                collapsed={isGroupCollapsed(group)}
                workspacePath={workspacePath}
                pending={pendingByWorkspace.get(group.workspacePath) ?? NO_PENDING}
                onOpenTree={setTreeFor}
                onWorktreeModal={setWorktreeModal}
              />
            ))}
        </div>
        <RemoteLanes />
      </div>

      <SidebarFooter />

      {treeFor && (
        <TreeViewModal
          meta={treeFor}
          workspacePath={treeFor.cwd || workspacePath}
          onClose={() => setTreeFor(null)}
        />
      )}
      {worktreeModal?.kind === 'remove' && (
        <RemoveWorktreeModal
          repoPath={worktreeModal.repoPath}
          worktree={worktreeModal.worktree}
          onClose={() => setWorktreeModal(null)}
        />
      )}
      {worktreeModal?.kind === 'merge' && (
        <MergeWorktreeModal
          repoPath={worktreeModal.repoPath}
          worktree={worktreeModal.worktree}
          onClose={() => setWorktreeModal(null)}
        />
      )}

      <LocalDeleteDialogs workspacePath={workspacePath} />

      {/* Width resize handle: an invisible strip over the right border. */}
      <div
        onPointerDown={startResize}
        className={clsx(
          'hover:bg-accent/40 absolute -right-0.5 top-0 z-30 h-full w-1 cursor-col-resize transition-colors',
          resizing && 'bg-accent/40',
        )}
      />
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize select-none" />}
    </aside>
  )
}
