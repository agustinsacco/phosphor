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

interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

/** Imperative context menu — call show() from onContextMenu handlers. */
let showMenu: ((state: ContextMenuState) => void) | null = null

export function showContextMenu(event: React.MouseEvent, items: ContextMenuItem[]): void {
  event.preventDefault()
  event.stopPropagation()
  showMenu?.({ x: event.clientX, y: event.clientY, items })
}

/**
 * The same menu, dropped from a button ("⋯") rather than at the pointer: a
 * keyboard-activated click has no pointer position to open at.
 */
export function showMenuBelow(anchor: HTMLElement, items: ContextMenuItem[]): void {
  const rect = anchor.getBoundingClientRect()
  showMenu?.({ x: rect.left, y: rect.bottom + 4, items })
}

export function ContextMenuHost(): React.JSX.Element | null {
  const [state, setState] = useState<ContextMenuState | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    showMenu = setState
    return () => {
      showMenu = null
    }
  }, [])

  useEffect(() => {
    if (!state) return
    const close = (): void => setState(null)
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
  }, [state])

  /*
   * Clamp against the menu's OWN box rather than a guessed one. The guess
   * (220px wide, 30px per row, separators ignored) was wrong in both axes as
   * soon as rows sized to their content, which put long menus off the bottom
   * of the window. A layout effect runs before paint, so the corrected
   * position is the first one drawn.
   */
  useLayoutEffect(() => {
    if (!state || !ref.current) {
      setPosition(null)
      return
    }
    const rect = ref.current.getBoundingClientRect()
    setPosition({
      x: Math.max(8, Math.min(state.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8)),
    })
  }, [state])

  if (!state) return null

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
          <button
            disabled={item.disabled}
            title={item.hint ? `${item.label} — ${item.hint}` : undefined}
            onClick={() => {
              setState(null)
              item.onClick()
            }}
            className={clsx(
              'flex w-full items-center gap-3 px-2.5 py-1 text-left text-lg transition-colors disabled:opacity-40',
              item.danger ? 'text-danger hover:bg-danger-soft' : 'hover:bg-bg-secondary',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && <span className="text-text-tertiary shrink-0 text-sm">{item.hint}</span>}
            {item.shortcut && (
              <span className="text-text-tertiary shrink-0 font-mono text-sm">{item.shortcut}</span>
            )}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
