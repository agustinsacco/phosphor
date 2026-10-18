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

export function FolderGlyph({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-info shrink-0"
    >
      {open ? (
        <path d="M5 19l2.7-7.2A2 2 0 0 1 9.6 10H21l-3 8.1a2 2 0 0 1-1.9 1.3H5zm0 0V5a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      )}
    </svg>
  )
}
