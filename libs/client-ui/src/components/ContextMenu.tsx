import { ActionSheet, ActionSheetItem } from '@/components/ActionSheet'
import { TooltipButton } from '@/components/Tooltip'
import { MenuGesture } from '@/components/menuGesture'
import { usePlatform } from '@/platform/Platform'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'

export interface ContextMenuItem {
  /** A verb or a noun, never a sentence — qualifiers go in `hint`. */
  label: string
  /**
   * Two or three muted words that qualify the action ("to trash", "spends
   * tokens"). Keeps the warning without growing the label into prose.
   */
  hint?: string
  /** Already formatted for the platform — see lib/shortcuts. */
  shortcut?: string
  danger?: boolean
  separatorAbove?: boolean
  disabled?: boolean
  onClick: () => void
}

export interface ContextMenuOptions {
  /** What the menu acts on. The phone action sheet shows it as its head. */
  title?: string
}

interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
  title?: string
  /** The element the menu belongs to; the phone sheet returns focus to it. */
  trigger: HTMLElement | null
}

/** Imperative context menu — call show() from onContextMenu handlers. */
let showMenu: ((state: ContextMenuState) => void) | null = null

function openMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
  options: ContextMenuOptions,
  trigger: HTMLElement | null,
): void {
  showMenu?.({ x, y, items, title: options.title, trigger })
}

export function showContextMenu(
  event: React.MouseEvent,
  items: ContextMenuItem[],
  options: ContextMenuOptions = {},
): void {
  event.preventDefault()
  event.stopPropagation()
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  openMenu(event.clientX, event.clientY, items, options, trigger)
}

/** The same menu at a point, for a native `contextmenu` listener outside React. */
export function showContextMenuAt(
  x: number,
  y: number,
  items: ContextMenuItem[],
  options: ContextMenuOptions = {},
): void {
  openMenu(x, y, items, options, null)
}

/**
 * The same menu, dropped from a button ("⋯") rather than at the pointer: a
 * keyboard-activated click has no pointer position to open at.
 */
export function showMenuBelow(
  anchor: HTMLElement,
  items: ContextMenuItem[],
  options: ContextMenuOptions = {},
): void {
  const rect = anchor.getBoundingClientRect()
  openMenu(rect.left, rect.bottom + 4, items, options, anchor)
}

export interface MenuTriggerOptions extends ContextMenuOptions {
  /** No menu and no vibration; every event passes through untouched. */
  disabled?: boolean
}

export interface MenuTriggerProps {
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void
  'data-menu-trigger': true
}

/**
 * Every way to open an element's menu, as props to spread onto it: right-click
 * at the pointer, the ContextMenu key or Shift+F10 below the element, and a
 * touch or pen long-press, which vibrates once where the device can and
 * swallows the click that follows. Mouse holds do nothing.
 *
 * Composing with the element's own handlers: `onClick` needs nothing, since a
 * long-press stops its click in capture first. For a prop the caller also
 * sets, call both and skip yours when the menu took the event:
 * `onKeyDown={(e) => { menu.onKeyDown(e); if (!e.defaultPrevented) own(e) }}`.
 */
export function useMenuTriggers(
  items: () => ContextMenuItem[],
  options: MenuTriggerOptions = {},
): MenuTriggerProps {
  const latest = useRef({ items, options })
  latest.current = { items, options }
  const [gesture] = useState(
    () =>
      new MenuGesture(
        () => latest.current.options.disabled === true,
        (x, y, trigger) => openMenu(x, y, latest.current.items(), latest.current.options, trigger),
      ),
  )
  useEffect(() => gesture.dispose, [gesture])
  return {
    'data-menu-trigger': true,
    onContextMenu: gesture.onContextMenu,
    onKeyDown: gesture.onKeyDown,
    onPointerDown: gesture.onPointerDown,
    onPointerMove: gesture.onPointerMove,
    onPointerUp: gesture.onRelease,
    onPointerCancel: gesture.onRelease,
    onClickCapture: gesture.onClickCapture,
  }
}

export function ContextMenuHost(): React.JSX.Element | null {
  const [state, setState] = useState<ContextMenuState | null>(null)
  const compact = usePlatform().formFactor === 'compact'

  useEffect(() => {
    showMenu = setState
    return () => {
      showMenu = null
    }
  }, [])

  if (!state) return null
  const close = (): void => setState(null)
  return compact ? (
    <ContextMenuSheet state={state} onClose={close} />
  ) : (
    <ContextMenuPopover state={state} onClose={close} />
  )
}

/** The phone's menu: the same rows as a bottom sheet, separators as group gaps. */
function ContextMenuSheet({
  state,
  onClose,
}: {
  state: ContextMenuState
  onClose: () => void
}): React.JSX.Element {
  const groups: ContextMenuItem[][] = []
  for (const item of state.items) {
    if (item.separatorAbove || groups.length === 0) groups.push([])
    groups[groups.length - 1]!.push(item)
  }
  return (
    <ActionSheet
      label={state.title ?? 'Menu'}
      head={state.title && <strong className="truncate">{state.title}</strong>}
      returnFocus={state.trigger}
      onClose={onClose}
    >
      <div data-testid="context-menu-sheet">
        {groups.map((group, index) => (
          <div key={index} role="group" className="action-sheet-group">
            {group.map((item) => (
              <ActionSheetItem
                key={item.label}
                danger={item.danger}
                disabled={item.disabled}
                hint={item.hint}
                onClick={() => {
                  onClose()
                  item.onClick()
                }}
              >
                {item.label}
              </ActionSheetItem>
            ))}
          </div>
        ))}
        <div className="action-sheet-group">
          <TooltipButton
            tooltip={false}
            className="action-sheet-item action-sheet-cancel"
            onClick={onClose}
          >
            Cancel
          </TooltipButton>
        </div>
      </div>
    </ActionSheet>
  )
}

function ContextMenuPopover({
  state,
  onClose,
}: {
  state: ContextMenuState
  onClose: () => void
}): React.JSX.Element {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const close = (): void => closeRef.current()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', handleOutside)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    function handleOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    return () => {
      window.removeEventListener('mousedown', handleOutside)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [])

  /*
   * Clamp against the menu's OWN box rather than a guessed one. The guess
   * (220px wide, 30px per row, separators ignored) was wrong in both axes as
   * soon as rows sized to their content, which put long menus off the bottom
   * of the window. A layout effect runs before paint, so the corrected
   * position is the first one drawn.
   */
  useLayoutEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPosition({
      x: Math.max(8, Math.min(state.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8)),
    })
  }, [state])

  return createPortal(
    <div
      ref={ref}
      data-testid="context-menu"
      className="border-border bg-surface-raised fixed z-50 max-h-[80vh] w-max min-w-44 max-w-72 overflow-y-auto rounded-lg border py-1 shadow-xl"
      style={{ left: position?.x ?? state.x, top: position?.y ?? state.y }}
    >
      {state.items.map((item, index) => (
        <div key={index}>
          {item.separatorAbove && <div className="border-border my-1 border-t" />}
          <PopoverRow item={item} onClose={onClose} />
        </div>
      ))}
    </div>,
    document.body,
  )
}

function PopoverRow({
  item,
  onClose,
}: {
  item: ContextMenuItem
  onClose: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      disabled={item.disabled}
      tooltip={{
        label: item.label,
        description: item.hint,
        shortcut: item.shortcut ? [item.shortcut] : undefined,
      }}
      onClick={() => {
        onClose()
        item.onClick()
      }}
      className={clsx(
        'flex w-full items-center gap-3 px-2.5 py-1 text-left text-lg transition-colors disabled:opacity-40',
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
