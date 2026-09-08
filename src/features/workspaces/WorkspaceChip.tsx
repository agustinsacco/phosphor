import { useRef, useState } from 'react'
import clsx from 'clsx'
import { MenuRow, PopupMenu } from '@/components/PopupMenu'
import { CheckIcon, ChevronIcon } from '@/components/icons'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { projectName } from '@/lib/path'

/**
 * Which folder you are in, and the menu to change it.
 *
 * Lifted out of WorkspaceHome so the top bar can host the real control rather
 * than a static label: sitting a dead span next to the interactive branch chip
 * read as a broken button. Folder and branch are the same kind of "where am I
 * working" question, so they belong side by side and both clickable.
 */
export function WorkspaceChip({
  workspacePath,
  /** `compact` is the top bar's flatter styling; the composer uses the border. */
  compact = false,
}: {
  workspacePath: string
  compact?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const recents = useWorkspacesStore((s) => s.recents)
  // The project, not the folder: with a worktree session open `workspacePath`
  // is `<repo>/.phosphor/worktrees/<branch-slug>`, and its basename read as if the
  // user had switched workspaces. The branch is the chip immediately to the
  // right of this one.
  const git = useSessionsStore((s) => s.gitByCwd[workspacePath])
  const name = projectName(workspacePath, git)

  const choose = (path: string): void => {
    setOpen(false)
    if (path === workspacePath) return
    useWorkspacesStore.getState().openWorkspace(path)
    // Leave any active session, or the derived workspace keeps pointing at it.
    useSessionsStore.getState().activate(null)
  }

  return (
    <span className="relative shrink-0">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        title={workspacePath}
        data-testid="workspace-chip"
        aria-expanded={open}
        className={clsx(
          'flex cursor-pointer items-center gap-1.5 transition-colors',
          compact
            ? 'bg-bg-secondary text-text-secondary hover:text-text rounded-md px-2 py-0.5 text-sm'
            : clsx(
                'border-border rounded-lg border px-2.5 py-1 text-base font-medium',
                open
                  ? 'bg-bg-secondary text-text border-border-strong'
                  : 'bg-surface text-text-secondary hover:text-text hover:border-border-strong',
              ),
        )}
      >
        <FolderIcon />
        <span className="max-w-40 truncate">{name}</span>
        <ChevronIcon size={10} className="text-text-tertiary" />
      </button>

      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fitViewport
          className={clsx(
            'absolute left-0 z-40 max-h-80 w-64 max-w-[calc(100vw-16rem)] overflow-y-auto py-1.5',
            // The composer chip sits near the bottom of the window, the top bar
            // chip at the very top, so they open in opposite directions.
            compact ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
          )}
        >
          <div className="text-text-tertiary px-3 pb-1 pt-1 font-mono text-xs font-medium uppercase tracking-wide">
            Recent
          </div>
          {recents.map((ws) => (
            <MenuRow key={ws.path} active={false} onClick={() => choose(ws.path)}>
              <span className="min-w-0 flex-1 truncate text-lg">{ws.name}</span>
              {ws.path === workspacePath && <CheckIcon className="text-accent shrink-0" />}
            </MenuRow>
          ))}
          <div className="border-border my-1 border-t" />
          <MenuRow
            active={false}
            onClick={() => {
              setOpen(false)
              void useWorkspacesStore
                .getState()
                .pickAndOpen()
                .then((path) => {
                  if (path) useSessionsStore.getState().activate(null)
                })
            }}
          >
            <span className="text-lg">Open folder…</span>
          </MenuRow>
          <MenuRow
            active={false}
            onClick={() => {
              setOpen(false)
              void useWorkspacesStore
                .getState()
                .openSandbox()
                .then(() => {
                  useSessionsStore.getState().activate(null)
                })
            }}
          >
            <span
              className="min-w-0 flex-1 truncate text-lg"
              title="Start in a fresh sandbox folder that belongs to no project"
            >
              No folder
            </span>
            <span className="text-text-tertiary shrink-0 text-sm">sandbox</span>
          </MenuRow>
        </PopupMenu>
      )}
    </span>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="shrink-0"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}
