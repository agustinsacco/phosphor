import { memo } from 'react'
import clsx from 'clsx'
import { useFilesStore, workspaceFiles, type OpenFile } from '@/stores/files'
import { isTextPreview, previewKindForPath } from '@shared/file-kinds'
import { MonacoEditor } from './MonacoEditor'
import { FileFallback, FileViewer } from './FileViewer'
import { basename } from '@/lib/path'
import { CloseIcon } from '@/components/icons'
import { formatShortcut } from '@/lib/shortcuts'

export const EditorPane = memo(function EditorPane({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  const openFiles = useFilesStore((s) => workspaceFiles(s, workspacePath).openFiles)
  const activePath = useFilesStore((s) => workspaceFiles(s, workspacePath).activePath)
  const active = openFiles.find((f) => f.path === activePath)

  if (openFiles.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="text-text-tertiary text-lg">No file open</div>
          <div className="text-text-tertiary mt-1 text-sm">
            Pick a file from the explorer or press {formatShortcut('mod', 'P')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b px-1.5 pt-1">
        {openFiles.map((file) => (
          <Tab
            key={file.path}
            file={file}
            active={file.path === activePath}
            workspacePath={workspacePath}
          />
        ))}
      </div>
      {active?.diskConflict && <ConflictBar file={active} workspacePath={workspacePath} />}
      <div className="min-h-0 flex-1">
        {active && <ActiveView file={active} workspacePath={workspacePath} />}
      </div>
    </div>
  )
})

/**
 * A previewable file gets its viewer (HTML/SVG keep their source one click
 * away); anything else is text in Monaco, or — binary or too large — a card
 * that hands it to the OS.
 */
function ActiveView({
  file,
  workspacePath,
}: {
  file: OpenFile
  workspacePath: string
}): React.JSX.Element {
  const kind = previewKindForPath(file.path)
  const text = <TextView file={file} workspacePath={workspacePath} />
  if (!kind) return text
  return (
    <FileViewer
      file={file}
      kind={kind}
      textPreview={isTextPreview(file.path)}
      workspacePath={workspacePath}
      source={text}
    />
  )
}

function TextView({
  file,
  workspacePath,
}: {
  file: OpenFile
  workspacePath: string
}): React.JSX.Element {
  if (file.binary || file.tooLarge) return <FileFallback file={file} />
  return <ActiveEditor file={file} workspacePath={workspacePath} />
}

function ActiveEditor({
  file,
  workspacePath,
}: {
  file: OpenFile
  workspacePath: string
}): React.JSX.Element {
  const revealLine = file.pendingRevealLine
  return (
    <MonacoEditor
      path={file.path}
      language={file.language}
      value={file.content}
      revealLine={revealLine}
      onChange={(value) => useFilesStore.getState().updateBuffer(workspacePath, file.path, value)}
      onSave={() => void useFilesStore.getState().saveFile(workspacePath, file.path)}
    />
  )
}

function Tab({
  file,
  active,
  workspacePath,
}: {
  file: OpenFile
  active: boolean
  workspacePath: string
}): React.JSX.Element {
  const name = basename(file.relativePath)
  return (
    <div
      className={clsx(
        'group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-sm border border-b-0 px-3 py-1.5 text-base transition-colors',
        active
          ? 'border-border bg-surface text-text'
          : 'border-transparent text-text-tertiary hover:text-text',
      )}
      onClick={() => useFilesStore.getState().setActive(workspacePath, file.path)}
      title={file.relativePath}
    >
      <span className="max-w-40 truncate">{name}</span>
      {file.dirty && <span className="bg-accent h-1.5 w-1.5 shrink-0 rounded-full" />}
      <button
        onClick={(event) => {
          event.stopPropagation()
          useFilesStore.getState().closeFile(workspacePath, file.path)
        }}
        className={clsx(
          'text-text-tertiary hover:text-text -mr-1 rounded p-0.5 transition-opacity',
          !file.dirty && 'opacity-0 group-hover:opacity-100',
        )}
      >
        <CloseIcon size={10} strokeWidth={2.5} />
      </button>
    </div>
  )
}

function ConflictBar({
  file,
  workspacePath,
}: {
  file: OpenFile
  workspacePath: string
}): React.JSX.Element {
  return (
    <div className="bg-warning/10 border-warning/30 flex items-center gap-2 border-b px-3 py-1.5 text-base">
      <span className="text-text flex-1">File changed on disk while you had unsaved edits.</span>
      <button
        onClick={() => void useFilesStore.getState().reloadFromDisk(workspacePath, file.path)}
        className="border-border hover:bg-bg-secondary rounded-md border px-2 py-0.5 font-medium transition-colors"
      >
        Reload
      </button>
      <button
        onClick={() => useFilesStore.getState().keepBuffer(workspacePath, file.path)}
        className="border-border hover:bg-bg-secondary rounded-md border px-2 py-0.5 font-medium transition-colors"
      >
        Keep mine
      </button>
    </div>
  )
}
