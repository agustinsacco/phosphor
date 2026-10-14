import { useEffect, useId, useRef, useState } from 'react'
import { PopupMenu, MenuRow } from './PopupMenu'
import { TooltipButton } from './Tooltip'
import { CheckIcon, ChevronDownIcon } from './icons'

export interface MenuChoice {
  value: string
  label: React.ReactNode
  disabled?: boolean
}

/** A focus-owned single-choice menu over the shared anchored popup. */
export function ChoiceMenu({
  value,
  choices,
  onChange,
  label,
  children,
  header,
  placement = 'below',
  triggerClassName,
  bordered = false,
}: {
  value: string
  choices: MenuChoice[]
  onChange: (value: string) => void
  label: string
  children: React.ReactNode
  header?: React.ReactNode
  placement?: 'above' | 'below'
  triggerClassName?: string
  bordered?: boolean
}): React.JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (open) document.getElementById(id)?.focus()
  }, [open, id])
  const close = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }
  const select = (i: number): void => {
    const choice = choices[i]
    if (!choice || choice.disabled) return
    onChange(choice.value)
    close()
  }
  const move = (direction: number): void => {
    let next = index
    for (let i = 0; i < choices.length; i++) {
      next = (next + direction + choices.length) % choices.length
      const choice = choices[next]
      if (choice && !choice.disabled) {
        setIndex(next)
        break
      }
    }
  }
  return (
    <div
      className="relative min-w-0"
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          if (!open) {
            setOpen(true)
            setIndex(
              Math.max(
                0,
                choices.findIndex((c) => c.value === value),
              ),
            )
            return
          }
          if (event.key === 'Home') setIndex(choices.findIndex((c) => !c.disabled))
          else if (event.key === 'End') setIndex(choices.findLastIndex((c) => !c.disabled))
          else move(event.key === 'ArrowDown' ? 1 : -1)
        } else if (open && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          select(index)
        } else if (open && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
        } else if (event.key === 'Tab') setOpen(false)
      }}
    >
      <TooltipButton
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className={
          triggerClassName ??
          `text-text-secondary hover:text-text hover:bg-sidebar-hover flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-base transition-colors ${bordered ? 'border-border border' : ''}`
        }
        onClick={() => {
          setIndex(
            Math.max(
              0,
              choices.findIndex((c) => c.value === value),
            ),
          )
          setOpen(!open)
        }}
      >
        <span
          className={`flex min-w-0 flex-1 items-center ${triggerClassName ? 'gap-2.5' : 'gap-2'}`}
        >
          {children}
        </span>
        <ChevronDownIcon size={12} />
      </TooltipButton>
      {open && (
        <PopupMenu
          triggerRef={trigger}
          onClose={close}
          role="listbox"
          id={id}
          ariaLabel={label}
          tabIndex={-1}
          ariaActiveDescendant={`${id}-${index}`}
          className={`[&:focus-visible]:outline-accent outline-none focus-visible:ring-1 focus-visible:ring-accent absolute left-0 z-40 max-h-[70vh] w-72 overflow-y-auto py-1 ${placement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          fitViewport
        >
          {header}
          {choices.map((choice, i) => (
            <MenuRow
              key={choice.value}
              type="button"
              active={i === index}
              disabled={choice.disabled}
              id={`${id}-${i}`}
              role="option"
              ariaSelected={choice.value === value}
              onHover={() => setIndex(i)}
              onClick={() => select(i)}
            >
              <span className="min-w-0 flex-1 py-1 text-base">{choice.label}</span>
              {choice.value === value && <CheckIcon className="text-accent shrink-0" />}
            </MenuRow>
          ))}
        </PopupMenu>
      )}
    </div>
  )
}
