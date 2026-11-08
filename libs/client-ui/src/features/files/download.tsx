import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { FILE_BYTES_ERRORS, FILE_BYTES_LIMITS } from '@shared/host-protocol-file-bytes'
import { useDownloadsStore } from '@/stores/downloads'
import type { FilesSource } from './filesSource'

/** Save a Host lane's file into Downloads; its progress shows under the Files pane. */
export function downloadEntry(source: FilesSource, entry: { relativePath: string }): void {
  if (source.features.download && source.sessionId)
    void useDownloadsStore.getState().start(source.sessionId, entry.relativePath)
}

/** The viewer's Download, refused up front for a file the Host would not send. */
export function DownloadButton({
  size,
  onDownload,
  compact = false,
}: {
  /** The size the Host reported, 0 when it did not say. */
  size: number
  onDownload: () => void
  compact?: boolean
}): React.JSX.Element {
  const tooLarge = size > FILE_BYTES_LIMITS.fileBytes
  return (
    <TooltipButton
      title={tooLarge ? FILE_BYTES_ERRORS.tooLarge : 'Save to this device’s Downloads folder'}
      disabled={tooLarge}
      onClick={onDownload}
      className={clsx(
        'border-border hover:bg-bg-secondary shrink-0 rounded-md border font-medium transition-colors disabled:opacity-50',
        compact ? 'px-1.5 py-0.5 text-sm' : 'px-2.5 py-1 text-base',
      )}
    >
      Download
    </TooltipButton>
  )
}
