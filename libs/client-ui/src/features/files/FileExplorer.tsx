import { FileTreeRow, FolderGlyph } from './FileTreeRow'
import { memo, useEffect, useRef } from 'react'
import clsx from 'clsx'
import type { DirEntry } from '@shared/models'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { showContextMenu, useMenuTriggers, type ContextMenuItem } from '@/components/ContextMenu'
import { revealLabel } from '@/lib/reveal'
import { ChevronIcon } from '@/components/icons'
import { createIn, renameEntry, trashEntry, runFileAction } from './fileActions'
import { downloadEntry } from './download'
import { useExplorer } from './useExplorer'
import { ExplorerToolbar } from './ExplorerToolbar'
import type { FilesSource } from './filesSource'

export const FileExplorer = memo(function FileExplorer({
  source,
}: {
  source: FilesSource
}): React.JSX.Element {
  const { workspacePath, features, writeRefusal } = source
  const rootEntries = useFilesStore((s) => s.entries[workspacePath])
  const listError = useFilesStore((s) => s.listErrors[workspacePath])
  const gitUnavailable = useFilesStore((s) => workspaceFiles(s, workspacePath).gitUnavailable)
  const controls = useExplorer(source)

  useEffect(() => {
    const store = useFilesStore.getState()
    // Always re-read on mount. A watcher event can legitimately arrive while
    // this pane is closed, and keeping the old cached root made reopening show
    // the same stale snapshot forever.
    void store.refreshDir(workspacePath, workspacePath)
    void store.refreshGitStatus(workspacePath)
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
        showContextMenu(event, [...createItems(source), ...controls.menu()])
      }}
    >
      <ExplorerToolbar source={source} controls={controls} />
      <div className="flex-1 overflow-y-auto py-1">
        {listError && (
          <p role="alert" className="text-text-tertiary px-3 py-2 text-base">
            {listError}
          </p>
        )}
        {gitUnavailable && (
          <p role="status" className="text-text-tertiary px-3 py-2 text-sm">
            Git status is unavailable.
          </p>
        )}
        {rootEntries === undefined && (
          <div className="text-text-tertiary animate-pulse px-3 py-2 text-base">Loading…</div>
        )}
        {rootEntries?.map((entry) => (
          <ExplorerRow
            key={entry.path}
            entry={entry}
            source={source}
            depth={0}
            controls={controls}
          />
        ))}
        {rootEntries?.length === 0 && !listError && (
          <div className="text-text-tertiary px-3 py-2 text-base">
            {writeRefusal
              ? 'Empty folder.'
              : features.clipboardFiles
                ? 'Empty folder. Create an entry above, drop files here, or right-click to import.'
                : 'Empty folder. Create an entry above.'}
          </div>
        )}
      </div>
      <ExplorerStatus source={source} controls={controls} />
    </div>
  )
})

/**
 * What the explorer is doing, and how to reach its actions. A phone has no right-click (a row's
 * long-press is its menu), so client-shell.css hides that hint there, and a line of only the
 * hint with it.
 */
function ExplorerStatus({
  source,
  controls,
}: {
  source: FilesSource
  controls: ReturnType<typeof useExplorer>
}): React.JSX.Element {
  const clipboard = source.features.clipboardFiles
  const [state, hint] = controls.busy
    ? ['Working…', null]
    : controls.dropDir
      ? ['Drop here · Option/Ctrl to copy', null]
      : controls.selected.length
        ? [`${controls.selected.length} selected`, ' · right-click for actions']
        : clipboard
          ? ['Drop files to import', ' · right-click for actions']
          : [null, 'Right-click for actions']
  return (
    <div
      role="status"
      data-hint-only={state ? undefined : true}
      className="border-border text-text-tertiary shrink-0 border-t px-2 py-1 text-xs"
    >
      {state}
      {hint && <span data-pointer-hint>{hint}</span>}
    </div>
  )
}

/** New file and folder, in `entry`'s folder (the root without one), when the lane takes writes. */
function createItems(source: FilesSource, entry?: DirEntry): ContextMenuItem[] {
  if (source.writeRefusal) return []
  return (['file', 'folder'] as const).map((kind, index) => ({
    label: `New ${kind}…`,
    separatorAbove: !!entry && index === 0,
    onClick: () => runFileAction(createIn(source.workspacePath, entry, kind)),
  }))
}

/** A row's menu: this device's actions when it is local, then create, clipboard, rename and delete. */
function rowMenu(
  source: FilesSource,
  entry: DirEntry,
  controls: ReturnType<typeof useExplorer>,
): ContextMenuItem[] {
  const { workspacePath, features, writeRefusal } = source
  const inMultiSelection =
    controls.selected.length > 1 && controls.selected.some((e) => e.path === entry.path)
  return [
    ...(features.osActions
      ? [
          {
            label: revealLabel(),
            onClick: () => void window.phosphor.invoke('app:revealPath', entry.path),
          },
          {
            label: 'Copy path',
            onClick: () => void navigator.clipboard.writeText(entry.path),
          },
        ]
      : []),
    {
      label: 'Copy relative path',
      onClick: () => void navigator.clipboard.writeText(entry.relativePath),
    },
    ...(features.download && !entry.isDirectory
      ? [
          {
            label: 'Download',
            hint: features.openDownloads ? 'to Downloads' : undefined,
            onClick: () => downloadEntry(source, entry),
          },
          ...(features.openDownloads
            ? [
                {
                  label: 'Open in default app',
                  onClick: () => downloadEntry(source, entry, 'open'),
                },
              ]
            : []),
        ]
      : []),
    ...createItems(source, entry),
    ...controls.menu(entry),
    ...(writeRefusal
      ? []
      : [
          {
            label: 'Rename…',
            disabled: controls.busy || inMultiSelection,
            onClick: () => runFileAction(renameEntry(workspacePath, entry)),
          },
          {
            label: 'Delete',
            disabled: controls.busy || inMultiSelection,
            hint: 'to trash',
            danger: true,
            separatorAbove: true,
            onClick: () => runFileAction(trashEntry(workspacePath, entry)),
          },
        ]),
  ]
}

const STATUS_DOTS: Record<string, { color: string; label: string }> = {
  M: { color: 'var(--px-warning)', label: 'modified' },
  A: { color: 'var(--px-success)', label: 'added' },
  '?': { color: 'var(--px-success)', label: 'untracked' },
  D: { color: 'var(--px-danger)', label: 'deleted' },
  R: { color: 'var(--px-info)', label: 'renamed' },
}

/**
 * A row's menu and drag: right-click, the menu key, or a touch or pen long-press, which a phone
 * shows as a sheet. Only a mouse drags, since a touch or pen hold is the menu a drag would race.
 */
function useRowGestures(
  source: FilesSource,
  entry: DirEntry,
  controls: ReturnType<typeof useExplorer>,
  row: React.RefObject<HTMLButtonElement | null>,
) {
  const menu = useMenuTriggers(
    () => {
      controls.context(entry)
      row.current?.focus()
      return rowMenu(source, entry, controls)
    },
    { title: entry.name },
  )
  const draggable = !controls.busy && !source.writeRefusal
  return {
    ...menu,
    draggable,
    onPointerDown: (event: React.PointerEvent<HTMLElement>): void => {
      event.currentTarget.draggable = draggable && event.pointerType === 'mouse'
      menu.onPointerDown(event)
    },
    onDragStart: (event: React.DragEvent): void => controls.dragStart(event, entry),
  }
}

function ExplorerRow({
  entry,
  source,
  depth,
  controls,
}: {
  entry: DirEntry
  source: FilesSource
  depth: number
  controls: ReturnType<typeof useExplorer>
}): React.JSX.Element {
  const { workspacePath } = source
  const isExpanded = useFilesStore((s) => s.expanded[entry.path] ?? false)
  const gitStatus = useFilesStore((s) => workspaceFiles(s, workspacePath).gitStatus)
  const isActive = useFilesStore((s) => workspaceFiles(s, workspacePath).activePath === entry.path)
  const activeRequest = useFilesStore((s) => workspaceFiles(s, workspacePath).activeRequest)
  const rowRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [isActive, activeRequest])

  const status = gitStatus[entry.relativePath]
  const statusChar = status?.trim()?.[0]
  const dot = statusChar ? STATUS_DOTS[statusChar] : undefined
  // Directory dot: any child dirty.
  const dirDirty =
    entry.isDirectory && Object.keys(gitStatus).some((p) => p.startsWith(entry.relativePath + '/'))

  const onClick = (event: React.MouseEvent): void => {
    if (!controls.select(entry, event)) return
    const store = useFilesStore.getState()
    if (entry.isDirectory) void store.toggleDir(workspacePath, entry.path)
    else if (!entry.symlink || entry.symlink === 'resolved')
      runFileAction(store.openFile(workspacePath, entry.path))
  }

  const linkLabel = entry.symlink && LINK_LABELS[entry.symlink]
  const description = [entry.isIgnored && 'Git-ignored', linkLabel].filter(Boolean).join(' · ')
  const gestures = useRowGestures(source, entry, controls, rowRef)

  return (
    <>
      <FileTreeRow
        ref={rowRef}
        aria-current={isActive ? 'true' : undefined}
        aria-description={description || undefined}
        data-path={entry.path}
        data-directory={entry.isDirectory}
        aria-pressed={controls.selected.some((e) => e.path === entry.path)}
        aria-expanded={entry.isDirectory ? isExpanded : undefined}
        {...gestures}
        onClick={onClick}
        depth={depth}
        active={
          isActive ||
          controls.selected.some((e) => e.path === entry.path) ||
          controls.dropDir === entry.path
        }
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
        <span className={clsx('min-w-0 flex-1 truncate', entry.isIgnored && 'text-text-tertiary')}>
          {entry.name}
        </span>
        {description && (
          <span
            aria-hidden="true"
            className="text-text-tertiary shrink-0 text-xs"
            data-tooltip={description}
          >
            {[entry.isIgnored && 'ignored', linkLabel].filter(Boolean).join(' · ')}
          </span>
        )}
        {(dot || dirDirty) && (
          <span
            data-tooltip={dot?.label ?? 'contains changes'}
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: dot?.color ?? 'var(--px-warning)' }}
          />
        )}
      </FileTreeRow>
      {entry.isDirectory && isExpanded && (
        <ExplorerChildren path={entry.path} source={source} depth={depth + 1} controls={controls} />
      )}
    </>
  )
}

const LINK_LABELS = {
  resolved: 'Symlink',
  loop: 'Symlink loop',
  unavailable: 'Unavailable symlink',
}

function ExplorerChildren({
  path,
  source,
  depth,
  controls,
}: {
  path: string
  source: FilesSource
  depth: number
  controls: ReturnType<typeof useExplorer>
}): React.JSX.Element {
  const children = useFilesStore((s) => s.entries[path])
  const error = useFilesStore((s) => s.listErrors[path])
  return (
    <>
      {(error || children === undefined) && (
        <div
          role={error ? 'alert' : undefined}
          className="text-text-tertiary py-1 text-sm"
          style={{ paddingLeft: 10 + depth * 14 }}
        >
          {error ?? '…'}
        </div>
      )}
      {children?.map((entry) => (
        <ExplorerRow
          key={entry.path}
          entry={entry}
          source={source}
          depth={depth}
          controls={controls}
        />
      ))}
    </>
  )
}
