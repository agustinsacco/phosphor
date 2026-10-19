import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'

/** One navigation row for the native sidebar and responsive browser navigation. */
export function NavigationItem({
  label,
  icon,
  badge = false,
  active = false,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  badge?: boolean
  active?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      onClick={onClick}
      aria-pressed={active}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'text-text group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-left text-lg transition-colors',
        active ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover',
      )}
    >
      <span
        className={clsx(
          'text-text-secondary group-hover:text-text flex h-[22px] w-[22px] shrink-0 items-center justify-center transition-colors',
          badge && 'border-border group-hover:border-border-strong rounded-full border',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </TooltipButton>
  )
}
