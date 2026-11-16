import { TooltipButton } from '@/components/Tooltip'
import { Suspense, useEffect, useState } from 'react'
import clsx from 'clsx'
import { extensionOf, type PreviewKind } from '@shared/file-kinds'
import { useFilesStore, type OpenFile } from '@/stores/files'
import { basename } from '@/lib/path'
import { formatBytes } from '@/lib/format'
import { revealLabel } from '@/lib/reveal'
import { hostPlatform } from '@/lib/shortcuts'
import { FileIcon } from '@/components/icons'
import { TextFileRender, ViewTabs } from './TextFilePreview'
import { MarkdownPreview } from './MarkdownPreview'
import { HostFileActions, type FileDownload } from './download'
import { usePreviewUrl, type PreviewSource } from './previewUrl'
import { openInDefaultApp, toastError } from './openInDefaultApp'
import type { FilesFeatures } from './filesSource'

/**
 * Viewers for the files Monaco cannot show: images, video, audio, PDFs, and
 * a rendered view of HTML/SVG/markdown beside their source.
 *
 * Every byte arrives over `phosphor-file://` from a grant main minted for this
 * one file (or, for HTML, this workspace) — see electron/fs/file-protocol.ts
 * for what a previewed page can and cannot do.
 */

interface FileViewerProps {
  file: OpenFile
  kind: PreviewKind
  /** HTML/SVG: also editable, so the bar offers Preview | Source. */
  textPreview: boolean
  workspacePath: string
  features: FilesFeatures
  textLimitBytes: number
  /** What Source shows — the editor, owned by EditorPane. */
  source: React.ReactNode
  /** Save the file on this device, where its machine serves its bytes. */
  download?: FileDownload
  /** A Host lane's handle, which previews of its bytes read through. */
  sessionId?: string
  /** The largest Host file this device previews from its bytes. */
  previewLimitBytes: number
}

/** Kinds a browser shows from a Blob: only in <img>, <audio> and <video>, never a frame. */
const BLOB_KINDS: readonly PreviewKind[] = ['image', 'video', 'audio']

/**
 * Where this file's preview reads its bytes, or null for none: a Host's media and PDFs stream
 * through it, and a browser reads its images and media whole, up to its cap. A browser never
 * embeds a PDF (Android Chrome cannot show one inline): it offers Download instead.
 */
function previewSource(
  { features, sessionId, file, previewLimitBytes }: FileViewerProps,
  kind: PreviewKind,
  textPreview: boolean,
): PreviewSource | null {
  if (features.mediaPreview) return { kind: 'local' }
  if (!sessionId || textPreview || kind === 'markdown') return null
  if (features.hostPreview === 'stream') return { kind: 'stream', sessionId }
  if (features.hostPreview !== 'blob' || !BLOB_KINDS.includes(kind)) return null
  return file.size <= previewLimitBytes ? { kind: 'blob', sessionId } : null
}

/** Why a browser shows a Host file it could preview as a card instead, when it is too large. */
function tooLargeToPreview({ features, file, previewLimitBytes }: FileViewerProps) {
  return features.hostPreview === 'blob' && file.size > previewLimitBytes
    ? `Larger than ${previewLimitBytes / 1024 / 1024} MB: too big to preview in a browser.`
    : undefined
}

export function FileViewer(props: FileViewerProps): React.JSX.Element {
  const { file, kind, textPreview, workspacePath, features, textLimitBytes, source, download } =
    props
  const view = textPreview ? (file.view ?? 'preview') : 'preview'
  // A Host's HTML, SVG and markdown render from the text it sent.
  const bytes = previewSource(props, kind, textPreview)
  const [detail, setDetail] = useState<string | null>(null)
  // A different file or a new version resets what the viewer measured.
  useEffect(() => setDetail(null), [file.path, file.mtimeMs])

  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        file={file}
        view={textPreview ? view : null}
        workspacePath={workspacePath}
        note={
          view === 'preview' && file.dirty && kind !== 'markdown' && features.mediaPreview
            ? 'Unsaved edits — the preview shows the saved file'
            : [detail, formatBytes(file.size)].filter(Boolean).join(' · ')
        }
        osActions={features.osActions}
        download={download}
      />
      <div className="min-h-0 flex-1">
        {view === 'source' ? (
          source
        ) : !bytes ? (
          // No bytes for this file: text renders from the buffer through the artifact sandbox,
          // and anything else has no viewer here.
          textPreview && !file.binary && !file.tooLarge ? (
            <Suspense fallback={null}>
              <TextFileRender kind={kind} path={file.path} content={file.content} />
            </Suspense>
          ) : (
            <FileFallback
              file={file}
              reason={tooLargeToPreview(props)}
              osActions={false}
              textLimitBytes={textLimitBytes}
              download={download}
            />
          )
        ) : (
          <Preview
            // Remount per file: a <video> must not carry playback position,
            // and an iframe must not flash the previous document.
            key={file.path}
            file={file}
            kind={kind}
            workspacePath={workspacePath}
            onDetail={setDetail}
            osActions={features.osActions}
            textLimitBytes={textLimitBytes}
            source={bytes}
            download={download}
          />
        )}
      </div>
    </div>
  )
}

/** Preview | Source where there is a source, what the viewer measured, and the file's actions. */
function ViewerBar({
  file,
  view,
  workspacePath,
  note,
  osActions,
  download,
}: {
  file: OpenFile
  view: 'preview' | 'source' | null
  workspacePath: string
  note: string
  osActions: boolean
  download?: FileDownload
}): React.JSX.Element {
  return (
    <div
      data-viewer-bar
      className="border-border flex h-8 shrink-0 items-center gap-2 overflow-x-auto border-b px-2 [&::-webkit-scrollbar]:hidden"
    >
      {view && (
        <ViewTabs
          view={view}
          onChange={(next) => useFilesStore.getState().setView(workspacePath, file.path, next)}
        />
      )}
      <span className="text-text-tertiary min-w-0 flex-1 truncate text-sm">{note}</span>
      {download && <HostFileActions size={file.size} download={download} compact />}
      {osActions && <FileActions path={file.path} compact />}
    </div>
  )
}

interface PreviewProps {
  file: OpenFile
  kind: PreviewKind
  workspacePath: string
  onDetail: (detail: string) => void
  osActions: boolean
  textLimitBytes: number
  source: PreviewSource
  download?: FileDownload
}

function Preview({
  file,
  kind,
  workspacePath,
  onDetail,
  osActions,
  textLimitBytes,
  source,
  download,
}: PreviewProps): React.JSX.Element {
  const { url, failed } = usePreviewUrl(workspacePath, file, source)
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  const fallback = { file, osActions, textLimitBytes, download }

  if (kind === 'markdown') {
    // Rendered from the live buffer, in-app — no iframe, no saved-file lag.
    // The grant URL is only the base relative images resolve against, so a
    // missing grant (browser harness) still renders, just without them.
    if (file.binary || file.tooLarge) return <FileFallback {...fallback} />
    return <MarkdownPreview text={file.content} urlBase={url ?? undefined} />
  }

  // A blob is only ever an <img>, <audio> or <video> source, never a frame's page.
  if (source.kind === 'blob' && !BLOB_KINDS.includes(kind)) return <FileFallback {...fallback} />
  if (failed || broken) {
    const playable = kind === 'video' || kind === 'audio'
    const reason = playable
      ? 'This format does not play here.'
      : 'This file could not be shown here.'
    return <FileFallback {...fallback} reason={reason} />
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

/** For files no viewer covers: say so, and offer the OS's ways to open it where there are some. */
export function FileFallback({
  file,
  reason,
  osActions,
  textLimitBytes,
  download,
}: {
  file: OpenFile
  reason?: string
  osActions: boolean
  textLimitBytes: number
  download?: FileDownload
}): React.JSX.Element {
  const ext = extensionOf(file.path)
  const why =
    reason ??
    (file.tooLarge
      ? `Larger than ${textLimitBytes / 1024 / 1024} MB — too big to open as text.`
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
            {/* A Host refuses an oversized read without saying the size. */}
            {file.size > 0 && `${formatBytes(file.size)} · `}
            {why}
          </div>
        </div>
        {osActions && <FileActions path={file.path} />}
        {download && <HostFileActions size={file.size} download={download} />}
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
        <TooltipButton className={button} onClick={() => void quickLook(path)}>
          Quick Look
        </TooltipButton>
      )}
      {/* Short in the viewer bar, so a narrow pane still shows the size. */}
      <TooltipButton
        className={button}
        title={compact ? 'Open in default app' : undefined}
        onClick={() => void openInDefaultApp(path)}
      >
        {compact ? 'Open' : 'Open in default app'}
      </TooltipButton>
      <TooltipButton
        className={button}
        title={compact ? revealLabel() : undefined}
        onClick={() => void reveal(path)}
      >
        {compact ? 'Reveal' : revealLabel()}
      </TooltipButton>
    </div>
  )
}

async function quickLook(path: string): Promise<void> {
  await window.phosphor.invoke('fs:quickLook', path).catch((e) => toastError(String(e)))
}

async function reveal(path: string): Promise<void> {
  await window.phosphor.invoke('app:revealPath', path).catch((e) => toastError(String(e)))
}
