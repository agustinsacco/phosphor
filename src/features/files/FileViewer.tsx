import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { extensionOf, type PreviewKind } from '@shared/file-kinds'
import { useFilesStore, type OpenFile } from '@/stores/files'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { basename } from '@/lib/path'
import { formatBytes } from '@/lib/format'
import { revealLabel } from '@/lib/reveal'
import { hostPlatform } from '@/lib/shortcuts'
import { FileIcon } from '@/components/icons'

/**
 * Viewers for the files Monaco cannot show: images, video, audio, PDFs, and
 * a rendered view of HTML/SVG beside their source.
 *
 * Every byte arrives over `phosphor-file://` from a grant main minted for this
 * one file (or, for HTML, this workspace) — see electron/fs/file-protocol.ts
 * for what a previewed page can and cannot do.
 */

/**
 * The file's preview URL, re-requested whenever it changes on disk.
 *
 * The grant is per file, not per version, so its URL is stable; the `v`
 * query is what makes the viewer reload after an agent rewrites the file.
 */
function usePreviewUrl(
  workspacePath: string,
  path: string,
  mtimeMs: number,
): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ base: string | null; failed: boolean }>({
    base: null,
    failed: false,
  })
  useEffect(() => {
    let cancelled = false
    setState({ base: null, failed: false })
    void window.phosphor
      .invoke('fs:previewUrl', workspacePath, path)
      .then((base) => !cancelled && setState({ base, failed: false }))
      .catch(() => !cancelled && setState({ base: null, failed: true }))
    return () => {
      cancelled = true
    }
  }, [workspacePath, path])
  const url = state.base ? `${state.base}?v=${Math.round(mtimeMs)}` : null
  return { url, failed: state.failed }
}

export function FileViewer({
  file,
  kind,
  textPreview,
  workspacePath,
  source,
}: {
  file: OpenFile
  kind: PreviewKind
  /** HTML/SVG: also editable, so the bar offers Preview | Source. */
  textPreview: boolean
  workspacePath: string
  /** What Source shows — the editor, owned by EditorPane. */
  source: React.ReactNode
}): React.JSX.Element {
  const view = textPreview ? (file.view ?? 'preview') : 'preview'
  const [detail, setDetail] = useState<string | null>(null)
  // A different file or a new version resets what the viewer measured.
  useEffect(() => setDetail(null), [file.path, file.mtimeMs])

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex h-8 shrink-0 items-center gap-2 overflow-x-auto border-b px-2 [&::-webkit-scrollbar]:hidden">
        {textPreview && (
          <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="View">
            <ViewTab
              active={view === 'preview'}
              onClick={() => useFilesStore.getState().setView(workspacePath, file.path, 'preview')}
            >
              Preview
            </ViewTab>
            <ViewTab
              active={view === 'source'}
              onClick={() => useFilesStore.getState().setView(workspacePath, file.path, 'source')}
            >
              Source
            </ViewTab>
          </div>
        )}
        <span className="text-text-tertiary min-w-0 flex-1 truncate text-sm">
          {view === 'preview' && file.dirty
            ? 'Unsaved edits — the preview shows the saved file'
            : [detail, formatBytes(file.size)].filter(Boolean).join(' · ')}
        </span>
        <FileActions path={file.path} compact />
      </div>
      <div className="min-h-0 flex-1">
        {view === 'source' ? (
          source
        ) : (
          <Preview
            // Remount per file: a <video> must not carry playback position,
            // and an iframe must not flash the previous document.
            key={file.path}
            file={file}
            kind={kind}
            workspacePath={workspacePath}
            onDetail={setDetail}
          />
        )}
      </div>
    </div>
  )
}

function Preview({
  file,
  kind,
  workspacePath,
  onDetail,
}: {
  file: OpenFile
  kind: PreviewKind
  workspacePath: string
  onDetail: (detail: string) => void
}): React.JSX.Element {
  const { url, failed } = usePreviewUrl(workspacePath, file.path, file.mtimeMs)
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])

  if (failed || broken) {
    return (
      <FileFallback
        file={file}
        reason={
          kind === 'video' || kind === 'audio'
            ? 'This format does not play here.'
            : 'This file could not be shown here.'
        }
      />
    )
  }
  if (!url) return <div className="h-full" />

  switch (kind) {
    case 'image':
      return (
        <div className="bg-bg-secondary flex h-full items-center justify-center overflow-auto p-4">
          <img
            src={url}
            alt={basename(file.relativePath)}
            className="max-h-full max-w-full object-contain"
            onLoad={(e) =>
              onDetail(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)
            }
            onError={() => setBroken(true)}
          />
        </div>
      )
    case 'video':
      return (
        <div className="flex h-full items-center justify-center bg-black">
          <video
            src={url}
            controls
            className="max-h-full max-w-full"
            onLoadedMetadata={(e) =>
              onDetail(`${e.currentTarget.videoWidth} × ${e.currentTarget.videoHeight}`)
            }
            onError={() => setBroken(true)}
          />
        </div>
      )
    case 'audio':
      return (
        <div className="flex h-full items-center justify-center p-6">
          <audio src={url} controls className="w-full max-w-lg" onError={() => setBroken(true)} />
        </div>
      )
    case 'pdf':
      return (
        // Deliberately NOT sandboxed: Chromium refuses to start its PDF viewer
        // in a sandboxed frame. What contains it instead is the response — a
        // single-file grant served as application/pdf with nosniff and a
        // `sandbox` CSP, so the bytes can only ever be a PDF — and the frame
        // is cross-origin to the app, so it cannot touch this document.
        <iframe src={url} title={basename(file.relativePath)} className="h-full w-full" />
      )
    case 'html':
      return (
        <iframe
          // No `allow-same-origin`: that is what keeps the page's origin
          // opaque, and with it the page could reach this app's storage.
          // Never add it. The response's CSP repeats the sandbox.
          sandbox="allow-scripts"
          src={url}
          title={basename(file.relativePath)}
          // A browser paints an unstyled page white; so does this, or a page
          // that sets no background is black text on the dark theme.
          className="h-full w-full bg-white"
        />
      )
  }
}

/** For files no viewer covers: say so, and offer the OS's ways to open it. */
export function FileFallback({
  file,
  reason,
}: {
  file: OpenFile
  reason?: string
}): React.JSX.Element {
  const ext = extensionOf(file.path)
  const why =
    reason ??
    (file.tooLarge
      ? 'Larger than 4 MB — too big to open as text.'
      : ext
        ? `No preview for .${ext} files.`
        : 'No preview for this file.')
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <FileIcon size={28} className="text-text-tertiary" />
        <div>
          <div className="text-text text-base font-medium break-all">
            {basename(file.relativePath)}
          </div>
          <div className="text-text-tertiary mt-0.5 text-sm">
            {formatBytes(file.size)} · {why}
          </div>
        </div>
        <FileActions path={file.path} />
      </div>
    </div>
  )
}

function FileActions({ path, compact = false }: { path: string; compact?: boolean }) {
  const mac = hostPlatform() === 'darwin'
  const button = clsx(
    'border-border hover:bg-bg-secondary shrink-0 rounded-md border font-medium transition-colors',
    compact ? 'px-1.5 py-0.5 text-sm' : 'px-2.5 py-1 text-base',
  )
  return (
    <div className={clsx('flex shrink-0 items-center', compact ? 'gap-1' : 'flex-wrap gap-2')}>
      {mac && (
        <button className={button} onClick={() => void quickLook(path)}>
          Quick Look
        </button>
      )}
      {/* Short in the viewer bar, so a narrow pane still shows the size. */}
      <button
        className={button}
        title={compact ? 'Open in default app' : undefined}
        onClick={() => void openInDefaultApp(path)}
      >
        {compact ? 'Open' : 'Open in default app'}
      </button>
      <button
        className={button}
        title={compact ? revealLabel() : undefined}
        onClick={() => void reveal(path)}
      >
        {compact ? 'Reveal' : revealLabel()}
      </button>
    </div>
  )
}

function toastError(message: string): void {
  useExtensionUiStore.getState().pushToast(message, 'error')
}

async function quickLook(path: string): Promise<void> {
  await window.phosphor.invoke('fs:quickLook', path).catch((e) => toastError(String(e)))
}

async function reveal(path: string): Promise<void> {
  await window.phosphor.invoke('app:revealPath', path).catch((e) => toastError(String(e)))
}

async function openInDefaultApp(path: string): Promise<void> {
  const result = await window.phosphor
    .invoke('fs:openInDefaultApp', path)
    .catch((e) => ({ ok: false as const, reason: 'failed' as const, message: String(e) }))
  if (result.ok) return
  if (result.reason === 'launchable') {
    toastError(
      `${basename(path)} would run a program if opened, so Phosphor will not open it. ` +
        `Use ${revealLabel()} instead.`,
    )
  } else if (result.reason === 'not-a-file') {
    toastError(`${basename(path)} is not a regular file.`)
  } else {
    toastError(result.message)
  }
}

function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-sm px-1.5 py-0.5 text-sm font-medium transition-colors',
        active ? 'bg-bg-secondary text-text' : 'text-text-tertiary hover:text-text',
      )}
    >
      {children}
    </button>
  )
}
