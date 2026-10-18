import { TooltipButton } from '@/components/Tooltip'
import { memo, useEffect, useRef } from 'react'
import clsx from 'clsx'
import { useFilesStore, workspaceFiles, type OpenFile } from '@/stores/files'
import { isTextPreview, previewKindForPath } from '@shared/file-kinds'
import { MonacoEditor } from './MonacoEditor'
import { FileFallback, FileViewer } from './FileViewer'
import { showContextMenu } from '@/components/ContextMenu'
import {
  closeEditorFiles,
  editorTabLabel,
  saveAllEditorFiles,
  useEditorTabShortcuts,
} from './editorTabActions'
import { CloseIcon } from '@/components/icons'
import { formatShortcut } from '@/lib/shortcuts'
import { runFileAction } from './fileActions'
import { closeEditorFile } from './closeEditorFile'

export const EditorPane = memo(function EditorPane({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  const openFiles = useFilesStore((s) => workspaceFiles(s, workspacePath).openFiles)
  const activePath = useFilesStore((s) => workspaceFiles(s, workspacePath).activePath)
  const active = openFiles.find((f) => f.path === activePath)
  useEditorTabShortcuts(workspacePath)

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
      <div
        role="tablist"
        aria-label="Open files"
        className="border-border flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b px-1.5 pt-1"
      >
        {openFiles.map((file) => (
          <Tab
            key={file.path}
            file={file}
            label={editorTabLabel(file, openFiles)}
            active={file.path === activePath}
            workspacePath={workspacePath}
          />
        ))}
      </div>
      {active && (
        <div className="border-border text-text-tertiary flex items-center gap-2 border-b px-3 py-1 text-xs">
          <span
            aria-label="Current file path"
            data-tooltip={active.path}
            className="min-w-0 flex-1 truncate"
          >
            {active.relativePath}
          </span>
          <TooltipButton
            title={`Save all (${formatShortcut('mod', 'alt', 'S')})`}
            onClick={() => runFileAction(saveAllEditorFiles(workspacePath))}
            className="hover:text-text shrink-0"
          >
            Save all
          </TooltipButton>
        </div>
      )}
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
  return (
    <MonacoEditor
      path={file.path}
      language={file.language}
      value={file.content}
      reveal={file.pendingReveal}
      onChange={(value) => useFilesStore.getState().updateBuffer(workspacePath, file.path, value)}
      onSave={() => runFileAction(useFilesStore.getState().saveFile(workspacePath, file.path))}
    />
  )
}

function Tab({
  file,
  label,
  active,
  workspacePath,
}: {
  file: OpenFile
  label: string
  active: boolean
  workspacePath: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      draggable
      onDragStart={(event) =>
        event.dataTransfer.setData('application/x-phosphor-editor-tab', file.path)
      }
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/x-phosphor-editor-tab'))
          event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        useFilesStore
          .getState()
          .moveTab(
            workspacePath,
            event.dataTransfer.getData('application/x-phosphor-editor-tab'),
            file.path,
          )
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault()
          runFileAction(closeEditorFile(workspacePath, file.path))
        }
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        const tabs = [
          ...event.currentTarget.parentElement!.querySelectorAll<HTMLElement>('[role="tab"]'),
        ]
        const index = tabs.indexOf(event.currentTarget)
        const next =
          event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (index - 1 + tabs.length) % tabs.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : undefined
        if (next !== undefined) {
          event.preventDefault()
          tabs[next]?.focus()
          tabs[next]?.click()
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.currentTarget.click()
        }
      }}
      onContextMenu={(event) => {
        const files = workspaceFiles(useFilesStore.getState(), workspacePath).openFiles
        const index = files.findIndex((f) => f.path === file.path)
        const close = (targets: OpenFile[]) =>
          runFileAction(
            closeEditorFiles(
              workspacePath,
              targets.filter((f) => !f.pinned).map((f) => f.path),
            ),
          )
        showContextMenu(event, [
          {
            label: 'Close',
            onClick: () => runFileAction(closeEditorFile(workspacePath, file.path)),
          },
          {
            label: 'Close others',
            onClick: () => close(files.filter((f) => f.path !== file.path)),
          },
          { label: 'Close to the right', onClick: () => close(files.slice(index + 1)) },
          { label: 'Close saved tabs', onClick: () => close(files.filter((f) => !f.dirty)) },
          {
            label: file.pinned ? 'Unpin tab' : 'Pin tab',
            separatorAbove: true,
            onClick: () => useFilesStore.getState().togglePinned(workspacePath, file.path),
          },
          {
            label: 'Reopen closed tab',
            onClick: () => runFileAction(useFilesStore.getState().reopenClosed(workspacePath)),
          },
          {
            label: 'Reveal in Explorer',
            onClick: () => useFilesStore.getState().setActive(workspacePath, file.path),
          },
          {
            label: 'Copy relative path',
            onClick: () => runFileAction(navigator.clipboard.writeText(file.relativePath)),
          },
        ])
      }}
      className={clsx(
        'group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-sm border border-b-0 px-3 py-1.5 text-base transition-colors',
        active
          ? 'border-border bg-surface text-text'
          : 'border-transparent text-text-tertiary hover:text-text',
      )}
      onClick={() => useFilesStore.getState().setActive(workspacePath, file.path)}
      data-tooltip={file.relativePath}
    >
      {file.pinned && (
        <span aria-hidden="true" className="text-accent">
          ●
        </span>
      )}
      <span className="max-w-48 truncate">{label}</span>
      {file.dirty && <span className="bg-accent h-1.5 w-1.5 shrink-0 rounded-full" />}
      <TooltipButton
        aria-label={`Close ${file.relativePath}`}
        onClick={(event) => {
          event.stopPropagation()
          runFileAction(closeEditorFile(workspacePath, file.path))
        }}
        className={clsx(
          'text-text-tertiary hover:text-text -mr-1 rounded p-0.5 transition-opacity',
          !file.dirty && 'opacity-0 group-hover:opacity-100',
        )}
      >
        <CloseIcon size={10} strokeWidth={2.5} />
      </TooltipButton>
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
      <TooltipButton
        onClick={() => void useFilesStore.getState().reloadFromDisk(workspacePath, file.path)}
        className="border-border hover:bg-bg-secondary rounded-md border px-2 py-0.5 font-medium transition-colors"
      >
        Reload
      </TooltipButton>
      <TooltipButton
        onClick={() => useFilesStore.getState().keepBuffer(workspacePath, file.path)}
        className="border-border hover:bg-bg-secondary rounded-md border px-2 py-0.5 font-medium transition-colors"
      >
        Keep mine
      </TooltipButton>
    </div>
  )
}
