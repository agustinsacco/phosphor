import { memo, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { openFileInWorkspace } from '@/stores/layout'
import { collectTouchedFiles, type TouchedFile } from './collectTouchedFiles'
import { reconstructOriginal } from './patch'
import { MonacoDiff } from './MonacoEditor'
import { languageForPath } from '@/lib/monaco'
import { basename } from '@/lib/path'
import { errorText } from '@shared/errors'

export const FilesChangedPane = memo(function FilesChangedPane({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const tools = useChatStore((s) =>
    activeSessionId ? s.sessions[activeSessionId]?.tools : undefined,
  )
  const baselineRef = useSessionsStore((s) =>
    activeSessionId ? s.baselines[activeSessionId] : undefined,
  )
  const [selected, setSelected] = useState<string | null>(null)
  const focusOnReturn = useRef<string | null>(null)

  const files = useMemo(
    () => (tools ? collectTouchedFiles(tools, workspacePath) : []),
    [tools, workspacePath],
  )
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, f) => ({
          additions: acc.additions + f.additions,
          deletions: acc.deletions + f.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  )

  const selectedFile = files.find((f) => f.relativePath === selected) ?? null

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="text-center">
          <div className="text-text-tertiary text-lg">No changes yet</div>
          <div className="text-text-tertiary mt-1 text-sm">
            Files the agent edits or creates in this session will appear here as reviewable diffs.
          </div>
        </div>
      </div>
    )
  }

  if (selectedFile) {
    return (
      <FileDiffView
        key={selectedFile.relativePath}
        workspacePath={workspacePath}
        file={selectedFile}
        baselineRef={baselineRef ?? null}
        onBack={() => {
          focusOnReturn.current = selectedFile.relativePath
          setSelected(null)
        }}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-text-tertiary text-xs font-semibold font-mono uppercase tracking-wider">
          Files changed
        </span>
        <span className="text-sm font-medium">
          {files.length} file{files.length === 1 ? '' : 's'}{' '}
          <span className="text-success">+{totals.additions}</span>{' '}
          <span className="text-danger">−{totals.deletions}</span>
        </span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {files.map((file) => (
          <FileRow
            key={file.relativePath}
            file={file}
            workspacePath={workspacePath}
            baselineRef={baselineRef ?? null}
            onOpen={() => setSelected(file.relativePath)}
            openRef={(node) => {
              if (node && focusOnReturn.current === file.relativePath) {
                focusOnReturn.current = null
                node.focus()
              }
            }}
          />
        ))}
      </div>
    </div>
  )
})

function FileRow({
  file,
  workspacePath,
  baselineRef,
  onOpen,
  openRef,
}: {
  file: TouchedFile
  workspacePath: string
  baselineRef: string | null
  onOpen: () => void
  openRef: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  const name = basename(file.relativePath)
  const dir = file.relativePath.slice(0, file.relativePath.length - name.length)

  const revert = async (event: React.MouseEvent): Promise<void> => {
    event.stopPropagation()
    if (!window.confirm(`Revert ${file.relativePath} to its state at session start?`)) return
    if (baselineRef) {
      await window.pidex.invoke('git:restoreFileTo', workspacePath, baselineRef, file.relativePath)
    } else if (file.created) {
      await window.pidex.invoke('fs:trash', `${workspacePath}/${file.relativePath}`)
    } else if (file.patches.length > 0) {
      const current = await window.pidex.invoke(
        'fs:readFile',
        `${workspacePath}/${file.relativePath}`,
      )
      const original = reconstructOriginal(current.content, file.patches)
      await window.pidex.invoke('fs:writeFile', `${workspacePath}/${file.relativePath}`, original)
    }
  }

  return (
    <div className="hover:bg-bg-secondary/70 group flex w-full items-center gap-2 px-3 transition-colors">
      <button
        ref={openRef}
        type="button"
        onClick={onOpen}
        aria-label={`View diff for ${file.relativePath}`}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
      >
        <span
          className={clsx(
            'shrink-0 rounded px-1 py-px text-2xs font-bold uppercase',
            file.created ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning',
          )}
        >
          {file.created ? 'A' : 'M'}
        </span>
        <span className="min-w-0 flex-1 truncate text-base">
          {dir && <span className="text-text-tertiary">{dir}</span>}
          <span className="text-text">{name}</span>
        </span>
        <span className="shrink-0 font-mono text-sm">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-danger">−{file.deletions}</span>
        </span>
      </button>
      <button
        onClick={(e) => void revert(e)}
        title="Revert to session start"
        className="text-text-tertiary hover:text-danger hidden shrink-0 rounded p-1 transition-colors group-hover:block"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8" />
        </svg>
      </button>
    </div>
  )
}

function FileDiffView({
  workspacePath,
  file,
  baselineRef,
  onBack,
}: {
  workspacePath: string
  file: TouchedFile
  baselineRef: string | null
  onBack: () => void
}): React.JSX.Element {
  const [original, setOriginal] = useState<string | null>(null)
  const [modified, setModified] = useState<string | null>(null)
  const [sideBySide, setSideBySide] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const absolute = `${workspacePath}/${file.relativePath}`
        const current = await window.pidex.invoke('fs:readFile', absolute).catch(() => null)
        const currentContent = current?.content ?? ''

        let baselineContent: string
        if (baselineRef) {
          baselineContent =
            (await window.pidex.invoke(
              'git:showFileAt',
              workspacePath,
              baselineRef,
              file.relativePath,
            )) ?? ''
        } else if (file.created) {
          baselineContent = ''
        } else {
          baselineContent = reconstructOriginal(currentContent, file.patches)
        }

        if (!cancelled) {
          setOriginal(baselineContent)
          setModified(currentContent)
        }
      } catch (err) {
        if (!cancelled) setError(errorText(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspacePath, file, baselineRef])

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-2">
        <button
          onClick={onBack}
          aria-label="Back to changed files"
          autoFocus
          className="text-text-secondary hover:text-text flex h-8 w-8 items-center justify-center rounded-md transition-colors"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{file.relativePath}</span>
        <span className="shrink-0 font-mono text-sm">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-danger">−{file.deletions}</span>
        </span>
        <button
          onClick={() => setSideBySide((v) => !v)}
          className="border-border hover:bg-bg-secondary shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors"
        >
          {sideBySide ? 'Inline' : 'Split'}
        </button>
        <button
          onClick={() => void openFileInWorkspace(workspacePath, file.relativePath)}
          className="border-border hover:bg-bg-secondary shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors"
        >
          Open file
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {error && <div className="text-danger p-4 text-base">{error}</div>}
        {original !== null && modified !== null && !error && (
          <MonacoDiff
            originalText={original}
            modifiedText={modified}
            language={languageForPath(file.relativePath)}
            renderSideBySide={sideBySide}
          />
        )}
        {(original === null || modified === null) && !error && (
          <div className="text-text-tertiary animate-pulse p-4 text-base">Computing diff…</div>
        )}
      </div>
    </div>
  )
}
