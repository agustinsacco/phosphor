import { useRef, type ComponentProps } from 'react'
import clsx from 'clsx'
import { TooltipButton } from './Tooltip'
import './UnderlinedTabs.css'

/** The navigation treatment shared by Machines and page tabs. */
export function UnderlinedTab({
  className,
  ...props
}: ComponentProps<typeof TooltipButton>): React.JSX.Element {
  return <TooltipButton {...props} className={clsx('underlined-tab text-base', className)} />
}

/** Automatic-activation tabs: arrows, Home and End move selection and focus together. */
export function UnderlinedTabs<T extends string>({
  id,
  label,
  value,
  tabs,
  onChange,
}: {
  id: string
  label: string
  value: T
  tabs: readonly { value: T; label: React.ReactNode }[]
  onChange: (value: T) => void
}): React.JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  return (
    <div
      role="tablist"
      aria-label={label}
      className="border-border flex shrink-0 gap-5 border-b px-4 pt-2"
    >
      {tabs.map((tab, index) => (
        <UnderlinedTab
          key={tab.value}
          ref={(node) => {
            refs.current[index] = node
          }}
          role="tab"
          id={`${id}-tab-${tab.value}`}
          aria-controls={`${id}-panel-${tab.value}`}
          aria-selected={tab.value === value}
          tabIndex={tab.value === value ? 0 : -1}
          onClick={() => onChange(tab.value)}
          onKeyDown={(event) => {
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : null
            if (next === null) return
            event.preventDefault()
            refs.current[next]?.focus()
            onChange(tabs[next]!.value)
          }}
        >
          {tab.label}
        </UnderlinedTab>
      ))}
    </div>
  )
}
