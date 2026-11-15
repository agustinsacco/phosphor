import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { useDownloadsStore } from '@/stores/downloads'
import { openInDefaultApp } from './openInDefaultApp'
import type { FilesSource } from './filesSource'

/**
 * Save a Host lane's file on this device, its progress under the Files pane: into Downloads
 * where files save natively, as a browser download in a browser. `open` then hands the saved
 * copy to the OS, which refuses anything it would run; only a native save can.
 */
export function downloadEntry(
  source: FilesSource,
  entry: { relativePath: string },
  then?: 'open',
): void {
  if (!source.features.download || !source.sessionId) return
  const open = then === 'open' && source.features.openDownloads
  void useDownloadsStore
    .getState()
    .start(source.sessionId, entry.relativePath)
    .then((saved) => (saved && open ? openInDefaultApp(saved) : undefined))
}

/** A Host file's Download, as the viewer and its "No preview" card offer it. */
export interface FileDownload {
  start(then?: 'open'): void
  /** The largest file this device takes, and why a larger one is refused up front. */
  limitBytes: number
  tooLarge: string
  /** Download, then open in its default app: where files save natively. */
  open: boolean
}

/** The open file's Download, where its Host sends bytes; undefined where it does not. */
export function fileDownload(
  source: FilesSource,
  file: { relativePath: string },
): FileDownload | undefined {
  if (!source.features.download) return undefined
  return {
    start: (then) => downloadEntry(source, file, then),
    limitBytes: source.byteLimits.download,
    tooLarge: source.byteLimits.tooLarge,
    open: source.features.openDownloads,
  }
}

/** The viewer's Download and Open, refused up front for a file this device would not take. */
export function HostFileActions({
  size,
  download,
  compact = false,
}: {
  /** The size the Host reported, 0 when it did not say. */
  size: number
  download: FileDownload
  compact?: boolean
}): React.JSX.Element {
  const tooLarge = size > download.limitBytes
  const button = clsx(
    'border-border hover:bg-bg-secondary shrink-0 rounded-md border font-medium transition-colors disabled:opacity-50',
    compact ? 'px-1.5 py-0.5 text-sm' : 'px-2.5 py-1 text-base',
  )
  return (
    <div className={clsx('flex shrink-0 items-center', compact ? 'gap-1' : 'gap-2')}>
      <TooltipButton
        title={
          tooLarge
            ? download.tooLarge
            : download.open
              ? 'Save to this device’s Downloads folder'
              : 'Download to this device'
        }
        disabled={tooLarge}
        onClick={() => download.start()}
        className={button}
      >
        Download
      </TooltipButton>
      {download.open && (
        <TooltipButton
          title={tooLarge ? download.tooLarge : 'Download, then open in its default app'}
          disabled={tooLarge}
          onClick={() => download.start('open')}
          className={button}
        >
          {compact ? 'Open' : 'Open in default app'}
        </TooltipButton>
      )}
    </div>
  )
}
