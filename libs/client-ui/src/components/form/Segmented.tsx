import { useRef } from 'react'
import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { useRowLabel } from './fields'
import type { SelectOption } from './Select'

const STEP: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/**
 * A few exclusive choices shown side by side: a radio group. One tab stop;
 * arrow keys, Home and End move the choice and focus together, skipping
 * disabled options. Named by `label`, else by its Row's title.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  label?: string
  disabled?: boolean
}): React.JSX.Element {
  const rowLabel = useRowLabel()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const enabled = (index: number): boolean => !disabled && !options[index]?.disabled
  const selected = options.findIndex((option) => option.value === value)
  // The checked option takes the tab stop; with none checked, the first enabled one does.
  const tabStop = selected >= 0 ? selected : options.findIndex((_, index) => enabled(index))
  const move = (from: number, key: string): void => {
    const count = options.length
    const order =
      key === 'Home'
        ? options.map((_, index) => index)
        : key === 'End'
          ? options.map((_, index) => count - 1 - index)
          : options.map((_, step) => (from + (step + 1) * STEP[key]! + count * count) % count)
    const next = order.find(enabled)
    if (next === undefined || next === from) return
    refs.current[next]?.focus()
    onChange(options[next]!.value)
  }
  return (
    <div
      role="radiogroup"
      aria-label={label ?? rowLabel}
      aria-disabled={disabled || undefined}
      className="border-border inline-flex flex-wrap overflow-hidden rounded-lg border"
    >
      {options.map((option, index) => (
        <TooltipButton
          key={option.value}
          ref={(node) => {
            refs.current[index] = node
          }}
          tooltip={false}
          role="radio"
          aria-checked={index === selected}
          tabIndex={index === tabStop ? 0 : -1}
          disabled={!enabled(index)}
          onClick={() => index !== selected && onChange(option.value)}
          onKeyDown={(event) => {
            if (!(event.key in STEP) && event.key !== 'Home' && event.key !== 'End') return
            event.preventDefault()
            move(index, event.key)
          }}
          className={clsx(
            'px-3 py-1.5 text-base font-medium transition-colors disabled:opacity-40',
            index === selected
              ? 'bg-accent text-accent-text'
              : 'text-text-secondary hover:text-text',
          )}
        >
          {option.label}
        </TooltipButton>
      ))}
    </div>
  )
}
