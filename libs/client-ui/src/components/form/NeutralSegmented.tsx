import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'

export function NeutralSegmented<T extends string>({
  value,
  options,
  onChange,
  wrap = false,
}: {
  value: T
  options: Array<{ id: T; label: string }>
  onChange: (next: T) => void
  wrap?: boolean
}): React.JSX.Element {
  return (
    <div
      className={clsx(
        'border-border flex shrink-0 overflow-hidden rounded-md border',
        wrap && 'min-w-0 max-w-full flex-wrap',
      )}
    >
      {options.map((option) => (
        <TooltipButton
          key={option.id}
          onClick={() => onChange(option.id)}
          aria-pressed={option.id === value}
          className={clsx(
            'cursor-pointer px-2.5 py-1 text-base transition-colors',
            option.id === value
              ? 'bg-bg-secondary text-text font-medium'
              : 'text-text-secondary hover:text-text',
          )}
        >
          {option.label}
        </TooltipButton>
      ))}
    </div>
  )
}
