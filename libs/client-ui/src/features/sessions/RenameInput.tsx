import { useRef } from 'react'

/** The title-sized editor used by in-app and Host lane rows. */
export function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
  maxLength,
  label = 'Session name',
}: {
  value: string
  onChange: (next: string) => void
  onCommit: () => void
  onCancel: () => void
  maxLength?: number
  label?: string
}): React.JSX.Element {
  const cancelled = useRef(false)
  return (
    <input
      autoFocus
      // Pre-selected: a double-click rename usually replaces the whole
      // generated title rather than editing a word of it.
      onFocus={(e) => e.target.select()}
      maxLength={maxLength}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        if (!cancelled.current) onCommit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.stopPropagation()
          cancelled.current = true
          onCancel()
        }
      }}
      aria-label={label}
      className="border-border focus:border-accent block h-5 w-full min-w-0 rounded border bg-transparent px-1 py-0 text-lg font-medium leading-5 outline-none"
      data-tooltip={label}
    />
  )
}
