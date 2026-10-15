import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'

/** Shared row geometry for local and Host explorers. */
export function FileTreeRow({
  depth,
  active,
  className,
  ...props
}: React.ComponentPropsWithRef<typeof TooltipButton> & {
  depth: number
  active: boolean
}): React.JSX.Element {
  return (
    <TooltipButton
      {...props}
      className={clsx(
        'group flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-base transition-colors disabled:opacity-40',
        active
          ? 'bg-accent-soft text-text'
          : 'text-text-secondary hover:bg-bg-secondary/60 hover:text-text',
        className,
      )}
      style={{ paddingLeft: 10 + depth * 14, ...props.style }}
    />
  )
}
