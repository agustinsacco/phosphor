import { memo, useEffect } from 'react'
import clsx from 'clsx'
import type { DirEntry } from '@shared/models'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { showContextMenu } from '@/components/ContextMenu'
import { revealLabel } from '@/lib/reveal'
import { BranchIcon, ChevronIcon } from '@/components/icons'
import { createIn, renameEntry, trashEntry, runFileAction } from './fileActions'
import { useExplorer } from './useExplorer'

export const FileExplorer = memo(function FileExplorer({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  const rootEntries = useFilesStore((s) => s.entries[workspacePath])
  const showHidden = useFilesStore((s) => s.showHidden)
  const respectGitignore = useFilesStore((s) => s.respectGitignore)
  const controls = useExplorer(workspacePath)

  useEffect(() => {
    const store = useFilesStore.getState()
    if (!store.entries[workspacePath]) {
      void store.refreshDir(workspacePath, workspacePath)
      void store.refreshGitStatus(workspacePath)
    }
  }, [workspacePath])

  return (
    <div
      {...controls.rootProps}
      data-testid="file-explorer"
      className={clsx(
        'flex h-full min-w-0 flex-col outline-none',
        controls.dropDir === workspacePath && 'bg-accent-soft ring-accent ring-1 ring-inset',
      )}
      onContextMenu={(event) => {
        controls.context()
        event.currentTarget.focus()
        showContextMenu(event, [
          {
            label: 'New file…',
            onClick: () => runFileAction(createIn(workspacePath, undefined, 'file')),
          },
          {
            label: 'New folder…',
            onClick: () => runFileAction(createIn(workspacePath, undefined, 'folder')),
          },
          ...controls.menu(),
        ])
      }}
    >
      <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-1 border-b px-2 py-1">
        <span className="text-text-tertiary text-xs font-semibold font-mono uppercase tracking-wider">
          Explorer
        </span>
        <div className="flex items-center gap-0.5">
          {(['file', 'folder'] as const).map((kind) => (
            <IconToggle
              key={kind}
              title={`New ${kind}`}
              active={false}
              onClick={() => runFileAction(createIn(workspacePath, controls.selected.at(-1), kind))}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d={kind === 'file' ? 'M14 2H4v20h16V8l-6-6v6h6' : 'M3 20V4h7l3 3h8v13H3'} />
                <path d="M8 14h8m-4-4v8" />
              </svg>
            </IconToggle>
          ))}
          <IconToggle
            title="Show hidden files"
            active={showHidden}
            onClick={() => useFilesStore.getState().setShowHidden(workspacePath, !showHidden)}
          >
            <EyeIcon />
          </IconToggle>
          <IconToggle
            title="Respect .gitignore"
            active={respectGitignore}
            onClick={() =>
              useFilesStore.getState().setRespectGitignore(workspacePath, !respectGitignore)
            }
          >
            <BranchIcon size={12} />
          </IconToggle>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {rootEntries === undefined && (
          <div className="text-text-tertiary animate-pulse px-3 py-2 text-base">Loading…</div>
        )}
        {rootEntries?.map((entry) => (
          <ExplorerRow
            key={entry.path}
            entry={entry}
            workspacePath={workspacePath}
            depth={0}
            controls={controls}
          />
        ))}
        {rootEntries?.length === 0 && (
          <div className="text-text-tertiary px-3 py-2 text-base">
            Empty folder. Create an entry above, drop files here, or right-click to import.
          </div>
        )}
      </div>
      <div
        role="status"
        className="border-border text-text-tertiary shrink-0 border-t px-2 py-1 text-xs"
      >
        {controls.busy
          ? 'Working…'
          : controls.dropDir
            ? 'Drop here · Option/Ctrl to copy'
            : controls.selected.length
              ? `${controls.selected.length} selected · right-click for actions`
              : 'Drop files to import · right-click for actions'}
      </div>
    </div>
  )
})

const STATUS_DOTS: Record<string, { color: string; label: string }> = {
  M: { color: 'var(--px-warning)', label: 'modified' },
  A: { color: 'var(--px-success)', label: 'added' },
  '?': { color: 'var(--px-success)', label: 'untracked' },
  D: { color: 'var(--px-danger)', label: 'deleted' },
  R: { color: 'var(--px-info)', label: 'renamed' },
}

function ExplorerRow({
  entry,
  workspacePath,
  depth,
  controls,
}: {
  entry: DirEntry
  workspacePath: string
  depth: number
  controls: ReturnType<typeof useExplorer>
}): React.JSX.Element {
  const isExpanded = useFilesStore((s) => s.expanded[entry.path] ?? false)
  const children = useFilesStore((s) => s.entries[entry.path])
  const gitStatus = useFilesStore((s) => workspaceFiles(s, workspacePath).gitStatus)
  const isActive = useFilesStore((s) => workspaceFiles(s, workspacePath).activePath === entry.path)

  const status = gitStatus[entry.relativePath]
  const statusChar = status?.trim()?.[0]
  const dot = statusChar ? STATUS_DOTS[statusChar] : undefined
  // Directory dot: any child dirty.
  const dirDirty =
    entry.isDirectory && Object.keys(gitStatus).some((p) => p.startsWith(entry.relativePath + '/'))

  const onClick = (event: React.MouseEvent): void => {
    if (!controls.select(entry, event)) return
    const store = useFilesStore.getState()
    if (entry.isDirectory) {
      void store.toggleDir(workspacePath, entry.path)
    } else {
      runFileAction(store.openFile(workspacePath, entry.path))
    }
  }

  const onContextMenu = (event: React.MouseEvent): void => {
    controls.context(entry)
    ;(event.currentTarget as HTMLElement).focus()
    showContextMenu(event, [
      {
        label: revealLabel(),
        onClick: () => void window.pidex.invoke('app:revealPath', entry.path),
      },
      {
        label: 'Copy path',
        onClick: () => void navigator.clipboard.writeText(entry.path),
      },
      {
        label: 'Copy relative path',
        onClick: () => void navigator.clipboard.writeText(entry.relativePath),
      },
      {
        label: 'New file…',
        separatorAbove: true,
        onClick: () => runFileAction(createIn(workspacePath, entry, 'file')),
      },
      {
        label: 'New folder…',
        onClick: () => runFileAction(createIn(workspacePath, entry, 'folder')),
      },
      ...controls.menu(entry),
      {
        label: 'Rename…',
        disabled:
          controls.busy ||
          (controls.selected.length > 1 && controls.selected.some((e) => e.path === entry.path)),
        onClick: () => runFileAction(renameEntry(workspacePath, entry)),
      },
      {
        label: 'Delete',
        disabled:
          controls.busy ||
          (controls.selected.length > 1 && controls.selected.some((e) => e.path === entry.path)),
        hint: 'to trash',
        danger: true,
        separatorAbove: true,
        onClick: () => runFileAction(trashEntry(workspacePath, entry)),
      },
    ])
  }

  return (
    <>
      <button
        data-path={entry.path}
        data-directory={entry.isDirectory}
        aria-pressed={controls.selected.some((e) => e.path === entry.path)}
        aria-expanded={entry.isDirectory ? isExpanded : undefined}
        draggable={!controls.busy}
        onDragStart={(event) => controls.dragStart(event, entry)}
        onClick={onClick}
        onContextMenu={onContextMenu}
        className={clsx(
          'group flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-base transition-colors',
          controls.selected.some((e) => e.path === entry.path) || controls.dropDir === entry.path
            ? 'bg-accent-soft text-text'
            : isActive
              ? 'bg-bg-secondary text-text'
              : 'text-text-secondary hover:bg-bg-secondary/60 hover:text-text',
        )}
        style={{ paddingLeft: 10 + depth * 14 }}
      >
        {entry.isDirectory ? (
          <>
            <ChevronIcon
              size={9}
              strokeWidth={3}
              expanded={isExpanded}
              className="text-text-tertiary"
            />
            <FolderGlyph open={isExpanded} />
          </>
        ) : (
          <span className="w-[13px]" />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {(dot || dirDirty) && (
          <span
            title={dot?.label ?? 'contains changes'}
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: dot?.color ?? 'var(--px-warning)' }}
          />
        )}
      </button>
      {entry.isDirectory && isExpanded && (
        <>
          {children === undefined && (
            <div
              className="text-text-tertiary animate-pulse py-1 text-sm"
              style={{ paddingLeft: 24 + depth * 14 }}
            >
              …
            </div>
          )}
          {children?.map((child) => (
            <ExplorerRow
              key={child.path}
              entry={child}
              workspacePath={workspacePath}
              depth={depth + 1}
              controls={controls}
            />
          ))}
        </>
      )}
    </>
  )
}

function IconToggle({
  title,
  active,
  onClick,
  children,
}: {
  title: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={clsx(
        'flex h-6 w-6 items-center justify-center rounded-sm transition-colors',
        active
          ? 'text-accent bg-accent-soft'
          : 'text-text-tertiary hover:text-text hover:bg-bg-secondary',
      )}
    >
      {children}
    </button>
  )
}

function FolderGlyph({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-info shrink-0"
    >
      {open ? (
        <path d="M5 19l2.7-7.2A2 2 0 0 1 9.6 10H21l-3 8.1a2 2 0 0 1-1.9 1.3H5zm0 0V5a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      )}
    </svg>
  )
}

function EyeIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
