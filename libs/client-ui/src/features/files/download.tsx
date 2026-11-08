import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { FILE_BYTES_ERRORS, FILE_BYTES_LIMITS } from '@shared/host-protocol-file-bytes'
import { useDownloadsStore } from '@/stores/downloads'
import { openInDefaultApp } from './openInDefaultApp'
import type { FilesSource } from './filesSource'

/**
 * Save a Host lane's file into Downloads, its progress under the Files pane;
 * `open` then hands the saved copy to the OS, which refuses anything it would run.
 */
export function downloadEntry(
  source: FilesSource,
  entry: { relativePath: string },
  then?: 'open',
): void {
  if (!source.features.download || !source.sessionId) return
  void useDownloadsStore
    .getState()
    .start(source.sessionId, entry.relativePath)
    .then((saved) => (saved && then === 'open' ? openInDefaultApp(saved) : undefined))
}

/** The viewer's Download and Open, refused up front for a file the Host would not send. */
export function HostFileActions({
  size,
  onDownload,
  compact = false,
}: {
  /** The size the Host reported, 0 when it did not say. */
  size: number
  onDownload: (then?: 'open') => void
  compact?: boolean
}): React.JSX.Element {
  const tooLarge = size > FILE_BYTES_LIMITS.fileBytes
  const button = clsx(
    'border-border hover:bg-bg-secondary shrink-0 rounded-md border font-medium transition-colors disabled:opacity-50',
    compact ? 'px-1.5 py-0.5 text-sm' : 'px-2.5 py-1 text-base',
  )
  return (
    <div className={clsx('flex shrink-0 items-center', compact ? 'gap-1' : 'gap-2')}>
      <TooltipButton
        title={tooLarge ? FILE_BYTES_ERRORS.tooLarge : 'Save to this device’s Downloads folder'}
        disabled={tooLarge}
        onClick={() => onDownload()}
        className={button}
      >
        Download
      </TooltipButton>
      <TooltipButton
        title={tooLarge ? FILE_BYTES_ERRORS.tooLarge : 'Download, then open in its default app'}
        disabled={tooLarge}
        onClick={() => onDownload('open')}
        className={button}
      >
        {compact ? 'Open' : 'Open in default app'}
      </TooltipButton>
    </div>
  )
}
