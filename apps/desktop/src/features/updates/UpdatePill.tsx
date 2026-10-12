import { TooltipButton } from '@/components/Tooltip'
import { useEffect } from 'react'
import clsx from 'clsx'
import { isUpdateVisible, useUpdatesStore } from './updatesStore'

/**
 * Bottom-left update affordance, above Settings in the sidebar footer.
 *
 * Deliberately quiet until there is something to act on: checking and idle
 * render nothing, and an update that failed to download renders nothing at all
 * (main logs it). Downloading is informational; only `downloaded` and
 * `manual-download` are clickable, because only those can do anything.
 */
export function UpdatePill(): React.JSX.Element | null {
  const update = useUpdatesStore((s) => s.update)
  const acting = useUpdatesStore((s) => s.acting)

  useEffect(() => useUpdatesStore.getState().subscribe(), [])

  if (!isUpdateVisible(update)) return null

  const ready = update.phase === 'downloaded'
  const manual = update.phase === 'manual-download'
  const installing = update.phase === 'installing'
  const clickable = ready || manual

  const label = ready
    ? 'Restart to update'
    : manual
      ? 'Update available — Download'
      : installing
        ? 'Installing update…'
        : 'Downloading update…'

  return (
    <TooltipButton
      type="button"
      disabled={!clickable || acting}
      data-testid="update-pill"
      data-phase={update.phase}
      onClick={() => void useUpdatesStore.getState().restartAndInstall()}
      title={
        update.version
          ? ready
            ? `Version ${update.version} is ready — restart to apply it`
            : manual
              ? `Version ${update.version} is available. This install can't update itself, so this opens the download page.`
              : installing
                ? `Verifying and unpacking version ${update.version}`
                : `Downloading version ${update.version}`
          : undefined
      }
      className={clsx(
        '-mx-1 mb-1 flex w-[calc(100%+8px)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-base transition-colors',
        ready
          ? 'bg-accent-soft text-accent hover:bg-accent hover:text-bg font-medium'
          : 'text-text-secondary hover:text-text hover:bg-bg-secondary',
        !clickable && 'cursor-default',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          ready ? 'bg-accent' : 'bg-text-tertiary animate-pulse',
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {update.phase === 'downloading' && update.progressPercent !== undefined && (
        <span className="text-text-tertiary shrink-0 text-xs tabular-nums">
          {update.progressPercent}%
        </span>
      )}
    </TooltipButton>
  )
}
