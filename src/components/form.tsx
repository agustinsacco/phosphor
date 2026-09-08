import { useEffect, useState } from 'react'
import clsx from 'clsx'

/**
 * Small form primitives shared by the settings tabs: labelled rows, a switch,
 * and numeric/text fields that commit on blur or Enter — plus the button and
 * text-input shapes every surface in the app was re-typing by hand.
 */

/**
 * The three button roles. `danger` keeps `text-white` rather than
 * `text-accent-text`: the danger token is dark enough for white ink in both
 * themes, which is not true of the amber accent (see docs/style-guide.md).
 */
const BUTTON_VARIANTS = {
  primary: 'bg-accent hover:bg-accent-hover text-accent-text',
  secondary: 'border-border hover:bg-bg-secondary border',
  danger: 'bg-danger hover:bg-danger/90 text-white',
} as const

/**
 * Padding, radius and type step together, so a size is self-contained. The
 * call sites had drifted across nine paddings for the same job; these are the
 * four that survived plus the one hero size the workspace picker needs.
 */
const BUTTON_SIZES = {
  xs: 'rounded-md px-2 py-1 text-sm',
  sm: 'rounded-md px-2.5 py-1 text-base',
  md: 'rounded-md px-3 py-1.5 text-base',
  lg: 'rounded-md px-4 py-2 text-lg',
  xl: 'rounded-lg px-5 py-2.5 text-lg',
} as const

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: React.ComponentPropsWithRef<'button'> & {
  variant?: keyof typeof BUTTON_VARIANTS
  size?: keyof typeof BUTTON_SIZES
}): React.JSX.Element {
  return (
    <button
      type={type}
      {...props}
      className={clsx(
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        'font-medium transition-colors disabled:opacity-50',
        className,
      )}
    />
  )
}

const INPUT_SIZES = {
  sm: 'rounded-md px-2 py-1 text-base',
  md: 'rounded-md px-2.5 py-1.5 text-base',
  lg: 'rounded-lg px-3 py-2 text-lg',
} as const

/**
 * Bordered single-line field. Focus is one border step, not a ring — the same
 * restraint the composer uses (`--px-border-focus` in the style guide).
 */
export function TextInput({
  size = 'md',
  className,
  ...props
}: Omit<React.ComponentPropsWithRef<'input'>, 'size'> & {
  /** Shadows the native (character-count) `size` attribute, which nothing here uses. */
  size?: keyof typeof INPUT_SIZES
}): React.JSX.Element {
  return (
    <input
      {...props}
      className={clsx(
        'border-border bg-surface text-text placeholder:text-text-tertiary border outline-none focus:border-[var(--px-border-strong)]',
        INPUT_SIZES[size],
        className,
      )}
    />
  )
}

export function SectionTitle({
  children,
  small,
}: {
  children: React.ReactNode
  small?: boolean
}): React.JSX.Element {
  return (
    <h2 className={clsx('font-semibold', small ? 'mb-2 mt-6 text-lg' : 'mb-4 text-xl')}>
      {children}
    </h2>
  )
}

export function Row({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-border flex items-center justify-between gap-6 border-b py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-lg font-medium">{title}</div>
        {description && (
          <div className="text-text-tertiary mt-0.5 text-sm leading-snug">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Toggle({
  on,
  onChange,
  disabled = false,
}: {
  on: boolean
  onChange: (on: boolean) => void
  /** Renders dimmed and refuses the click — a switch that cannot move must look it. */
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={clsx(
        'relative h-[22px] w-10 rounded-full transition-colors',
        on ? 'bg-accent' : 'bg-border-strong',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <span
        className={clsx(
          'absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all',
          on ? 'left-[21px]' : 'left-[3px]',
        )}
      />
    </button>
  )
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step: number
  suffix?: string
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!Number.isNaN(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
        className="border-border bg-surface text-text w-24 rounded-lg border px-2.5 py-1.5 text-right text-base outline-none"
      />
      {suffix && <span className="text-text-tertiary text-sm">{suffix}</span>}
    </span>
  )
}

export function TextField({
  defaultValue,
  placeholder,
  onCommit,
}: {
  defaultValue: string
  placeholder?: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(defaultValue)
  useEffect(() => setValue(defaultValue), [defaultValue])
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value !== defaultValue) onCommit(value.trim())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className="border-border bg-surface text-text placeholder:text-text-tertiary w-56 rounded-lg border px-2.5 py-1.5 text-base outline-none"
    />
  )
}
