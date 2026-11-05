import clsx from 'clsx'
import { useRowLabel } from './fields'

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  disabled?: boolean
}

/**
 * A native single choice. Native on purpose: WebKit's picker, keyboard search
 * and the `combobox` role e2e tests select by all come with it. Named by
 * `label`, else by its Row's title.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  label?: string
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  const rowLabel = useRowLabel()
  return (
    <select
      aria-label={label ?? rowLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className={clsx(
        'border-border bg-surface text-text min-w-0 max-w-full rounded-lg border px-2.5 py-1.5 text-base outline-none disabled:opacity-50',
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
