import { TooltipButton } from '@/components/Tooltip'
import { CloseIcon, DownloadIcon } from '@/components/icons'
import { formatBytes } from '@/lib/format'
import { revealLabel } from '@/lib/reveal'
import { useDownloadsStore, type Download } from '@/stores/downloads'
import { openInDefaultApp } from './openInDefaultApp'

/**
 * Host files being saved into Downloads: how far each has got, Cancel while it
 * runs, and where it landed once it has. Shown under the Files pane while any
 * download is running or was just finished.
 */
export function DownloadsBar(): React.JSX.Element | null {
  const items = useDownloadsStore((s) => s.items)
  if (!items.length) return null
  return (
    <ul aria-label="Downloads" className="border-border shrink-0 border-t py-1">
      {items.map((d) => (
        <DownloadRow key={d.id} download={d} />
      ))}
    </ul>
  )
}

const button = 'hover:text-text shrink-0 rounded px-1.5 py-0.5 font-medium'

function DownloadRow({ download: d }: { download: Download }): React.JSX.Element {
  const { cancel, dismiss } = useDownloadsStore.getState()
  const percent = d.size ? Math.min(100, Math.round((d.received / d.size) * 100)) : 0
  const detail =
    d.status === 'done'
      ? 'Saved to Downloads'
      : d.status === 'failed'
        ? d.error
        : d.size === null
          ? 'Starting…'
          : `${formatBytes(d.received)} of ${formatBytes(d.size)}`
  return (
    <li className="text-text-tertiary flex items-center gap-2 px-3 py-1 text-sm">
      <DownloadIcon size={12} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-text truncate">{d.name}</span>
          <span
            role={d.status === 'failed' ? 'alert' : 'status'}
            className={d.status === 'failed' ? 'text-danger truncate' : 'truncate'}
          >
            {detail}
          </span>
        </div>
        {d.status === 'running' && (
          <div
            role="progressbar"
            aria-label={`Downloading ${d.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="bg-border mt-1 h-1 overflow-hidden rounded-full"
          >
            <div className="bg-accent h-full transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      {d.status === 'running' ? (
        <TooltipButton className={button} onClick={() => cancel(d.id)}>
          Cancel
        </TooltipButton>
      ) : (
        <>
          {d.savedTo && (
            <TooltipButton className={button} onClick={() => void openInDefaultApp(d.savedTo!)}>
              Open
            </TooltipButton>
          )}
          {d.savedTo && (
            <TooltipButton
              className={button}
              onClick={() =>
                void window.phosphor.invoke('app:revealPath', d.savedTo!).catch(() => undefined)
              }
            >
              {revealLabel()}
            </TooltipButton>
          )}
          <TooltipButton
            title="Dismiss"
            aria-label={`Dismiss ${d.name}`}
            className={button}
            onClick={() => dismiss(d.id)}
          >
            <CloseIcon size={10} />
          </TooltipButton>
        </>
      )}
    </li>
  )
}
