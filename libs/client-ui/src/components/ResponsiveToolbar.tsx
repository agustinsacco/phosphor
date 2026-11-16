import { usePlatform } from '@/platform/Platform'
import { showMenuBelow, type ContextMenuItem } from './ContextMenu'
import { TooltipButton } from './Tooltip'

/** A phone keeps only the primary controls; secondary actions share one bottom sheet. */
export function ResponsiveToolbar({
  expanded,
  primary,
  actions,
  label,
}: {
  expanded: React.ReactNode
  primary: React.ReactNode
  actions: ContextMenuItem[]
  label: string
}): React.JSX.Element {
  if (usePlatform().formFactor !== 'compact') return <>{expanded}</>
  return (
    <div className="flex min-h-11 items-center gap-2">
      {primary}
      <TooltipButton
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        className="text-text-secondary hover:bg-bg-secondary flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-lg"
        onClick={(event) => showMenuBelow(event.currentTarget, actions, { title: label })}
      >
        ⋯
      </TooltipButton>
    </div>
  )
}
