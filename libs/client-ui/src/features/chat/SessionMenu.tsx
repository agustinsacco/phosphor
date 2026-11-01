import clsx from 'clsx'
import { showMenuBelow } from '@/components/ContextMenu'
import { TooltipButton } from '@/components/Tooltip'
import { usePlatform } from '@/platform/Platform'
import { currentSessionMenuItems, SESSION_OPTIONS } from './sessionMenuItems'

/**
 * The session's ⋮ button. It opens the shared session options
 * (`sessionMenuItems`) below itself: a popover on wide screens, the action
 * sheet on phones.
 */
export function SessionMenu({
  sessionId,
  className,
}: {
  sessionId: string
  className?: string
}): React.JSX.Element {
  const { nativeFiles } = usePlatform()
  return (
    <TooltipButton
      onClick={(event) =>
        showMenuBelow(event.currentTarget, currentSessionMenuItems(sessionId, nativeFiles), {
          title: SESSION_OPTIONS,
        })
      }
      className={clsx(
        'text-text-tertiary hover:text-text hover:bg-bg-secondary flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
        className,
      )}
      title={SESSION_OPTIONS}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="12" cy="5" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="12" cy="19" r="1.8" />
      </svg>
    </TooltipButton>
  )
}
