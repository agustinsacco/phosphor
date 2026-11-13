import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import type { ContextMenuItem } from './ContextMenu'

const ROW_CLASS =
  'flex w-full items-center gap-3 px-2.5 py-1 text-left text-lg transition-colors disabled:opacity-40'
export const CONTEXT_MENU_PANEL_CLASS =
  'border-border bg-surface-raised fixed z-50 max-h-[80vh] w-max min-w-44 max-w-72 overflow-y-auto rounded-lg border py-1 shadow-xl'

interface OpenSubmenu {
  index: number
  anchor: HTMLElement
  /** Opened from the keyboard: focus moves into it. */
  focus: boolean
}

/** Which row's submenu is open. `back` closes it, returning focus to its row; false when none was. */
export function useOpenSubmenu() {
  const [open, setOpen] = useState<OpenSubmenu | null>(null)
  const latest = useRef(open)
  latest.current = open
  const back = useCallback((): boolean => {
    if (!latest.current) return false
    latest.current.anchor.focus()
    setOpen(null)
    return true
  }, [])
  return { open, setOpen, back }
}

/** The desktop menu's rows, and the one submenu open beside them. */
export function MenuRows({
  items,
  onClose,
  submenu: { open, setOpen, back },
}: {
  items: ContextMenuItem[]
  onClose: () => void
  submenu: ReturnType<typeof useOpenSubmenu>
}): React.JSX.Element {
  const nested = open && items[open.index]
  return (
    <>
      {items.map((item, index) => (
        <div key={index}>
          {item.separatorAbove && <div className="border-border my-1 border-t" />}
          {item.submenu ? (
            <SubmenuRow
              item={item}
              open={open?.index === index}
              onOpen={(anchor, focus) => setOpen({ index, anchor, focus })}
            />
          ) : (
            <PopoverRow item={item} onClose={onClose} onPointerEnter={() => setOpen(null)} />
          )}
        </div>
      ))}
      {open && nested && nested.submenu && (
        <SubmenuPanel
          items={nested.submenu}
          label={nested.label}
          anchor={open.anchor}
          focusFirst={open.focus}
          onClose={onClose}
          onBack={back}
        />
      )}
    </>
  )
}

/** One action row of the desktop menu, or of a submenu panel. */
function PopoverRow({
  item,
  onClose,
  onPointerEnter,
}: {
  item: ContextMenuItem
  onClose: () => void
  onPointerEnter?: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      disabled={item.disabled}
      tooltip={{
        label: item.label,
        description: item.hint,
        shortcut: item.shortcut ? [item.shortcut] : undefined,
      }}
      onPointerEnter={onPointerEnter}
      onClick={() => {
        onClose()
        item.onClick()
      }}
      className={clsx(
        ROW_CLASS,
        item.danger ? 'text-danger hover:bg-danger-soft' : 'hover:bg-bg-secondary',
      )}
    >
      {/* The label never gives way to its hint: a long hint (a disabled row's reason)
          wraps beside it, and only a label wider than the whole menu truncates. */}
      <span className="max-w-full shrink-0 grow truncate">{item.label}</span>
      {item.hint && (
        <span className="text-text-tertiary min-w-0 text-right text-sm">{item.hint}</span>
      )}
      {item.shortcut && (
        <span className="text-text-tertiary shrink-0 font-mono text-sm">{item.shortcut}</span>
      )}
    </TooltipButton>
  )
}

/**
 * A row that opens a submenu beside it: on hover, on click, and on Enter,
 * Space or ArrowRight, which also move focus into the submenu.
 */
function SubmenuRow({
  item,
  open,
  onOpen,
}: {
  item: ContextMenuItem
  open: boolean
  onOpen: (anchor: HTMLElement, focus: boolean) => void
}): React.JSX.Element {
  return (
    <TooltipButton
      tooltip={false}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={item.disabled}
      onPointerEnter={(event) => onOpen(event.currentTarget, false)}
      // A keyboard click has no pointer position (`detail` 0): it moves focus in.
      onClick={(event) => onOpen(event.currentTarget, event.detail === 0)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight') return
        event.preventDefault()
        onOpen(event.currentTarget, true)
      }}
      className={clsx(ROW_CLASS, 'hover:bg-bg-secondary', open && 'bg-bg-secondary')}
    >
      <span className="max-w-full shrink-0 grow truncate">{item.label}</span>
      {item.hint && (
        <span className="text-text-tertiary min-w-0 text-right text-sm">{item.hint}</span>
      )}
      <span aria-hidden className="text-text-tertiary shrink-0 text-sm">
        ›
      </span>
    </TooltipButton>
  )
}

/**
 * A submenu beside its row, flipped to the row's left when the window has no
 * room on the right. Rendered inside the menu's own box, so a click in it is
 * not an outside click; `fixed` keeps it clear of the menu's scroll clip.
 */
function SubmenuPanel({
  items,
  anchor,
  focusFirst,
  label,
  onClose,
  onBack,
}: {
  items: ContextMenuItem[]
  anchor: HTMLElement
  focusFirst: boolean
  label: string
  onClose: () => void
  /** ArrowLeft: close the submenu and return focus to its row. */
  onBack: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    if (!ref.current) return
    const row = anchor.getBoundingClientRect()
    const own = ref.current.getBoundingClientRect()
    const right = row.right - 2
    const x = right + own.width + 8 <= window.innerWidth ? right : row.left - own.width + 2
    const y = Math.min(row.top - 5, window.innerHeight - own.height - 8)
    setPosition({ x: Math.max(8, x), y: Math.max(8, y) })
    if (focusFirst) ref.current.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }, [anchor, focusFirst])
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      data-testid="context-submenu"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft') return
        event.preventDefault()
        onBack()
      }}
      className={CONTEXT_MENU_PANEL_CLASS}
      style={{
        left: position?.x ?? anchor.getBoundingClientRect().right,
        top: position?.y ?? anchor.getBoundingClientRect().top,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {items.map((item, index) => (
        <div key={index}>
          {item.separatorAbove && <div className="border-border my-1 border-t" />}
          <PopoverRow item={item} onClose={onClose} />
        </div>
      ))}
    </div>
  )
}
