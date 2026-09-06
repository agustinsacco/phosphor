import { createContext, useContext, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'

/**
 * Escape-dismissible surfaces, innermost first.
 *
 * Listeners on `window` all fire regardless of `stopPropagation` (it cannot
 * stop siblings registered on the same target), so nesting is resolved with an
 * explicit stack instead: only the most recently mounted entry handles the
 * key. Without this, Escape inside a nested editor also closed its parent,
 * discarding unsaved edits.
 */
interface EscapeEntry {
  onEscape: () => void
  /** React tree depth: deeper is more nested, so it wins. */
  depth: number
}

const escapeEntries: EscapeEntry[] = []

let escapeListenerAttached = false

function handleWindowEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  let innermost: EscapeEntry | undefined
  for (const entry of escapeEntries) {
    if (!innermost || entry.depth >= innermost.depth) innermost = entry
  }
  if (!innermost) return
  event.stopPropagation()
  innermost.onEscape()
}

/**
 * Nesting depth for Escape precedence. React runs child effects before parent
 * ones, so registration order cannot tell us which surface is innermost —
 * context does.
 */
const EscapeDepthContext = createContext(0)

/**
 * Escape-to-close, as a hook so non-overlay surfaces (popovers, inline
 * editors) can share it. When several are mounted, the innermost wins.
 */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  const depth = useContext(EscapeDepthContext)

  // Keep the latest callback without re-registering on every render.
  const callbackRef = useRef(onEscape)
  callbackRef.current = onEscape

  useEffect(() => {
    if (!enabled) return

    const entry: EscapeEntry = { onEscape: () => callbackRef.current(), depth }
    escapeEntries.push(entry)
    if (!escapeListenerAttached) {
      window.addEventListener('keydown', handleWindowEscape, true)
      escapeListenerAttached = true
    }

    return () => {
      const index = escapeEntries.indexOf(entry)
      if (index !== -1) escapeEntries.splice(index, 1)
      if (escapeEntries.length === 0 && escapeListenerAttached) {
        window.removeEventListener('keydown', handleWindowEscape, true)
        escapeListenerAttached = false
      }
    }
  }, [enabled, depth])
}

/** Backdrop treatments, matching the variants already in use. */
const BACKDROPS = {
  dim: 'bg-black/40',
  blur: 'bg-black/40 backdrop-blur-sm',
  strong: 'bg-black/50',
  photo: 'bg-black/60 backdrop-blur-sm',
} as const

export interface ModalOverlayProps {
  onClose: () => void
  children: React.ReactNode
  /** `top` offsets the panel for command-palette style surfaces. */
  align?: 'center' | 'top'
  backdrop?: keyof typeof BACKDROPS
  /** Nested modals sit above their parent. */
  z?: 40 | 50
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  /** Extra classes for the backdrop element (e.g. palette padding). */
  className?: string
}

/**
 * Portal-rendered modal backdrop with consistent Escape and click-outside
 * behavior. Children are wrapped in a click-stopping element so clicks inside
 * the panel never reach the backdrop's close handler.
 */
export function ModalOverlay({
  onClose,
  children,
  align = 'center',
  backdrop = 'blur',
  z = 50,
  closeOnBackdrop = true,
  closeOnEscape = true,
  className,
}: ModalOverlayProps): React.JSX.Element {
  const depth = useContext(EscapeDepthContext)
  useEscapeKey(onClose, closeOnEscape)

  return createPortal(
    <div
      data-modal-overlay=""
      className={clsx(
        'fixed inset-0 flex justify-center',
        z === 40 ? 'z-40' : 'z-50',
        align === 'center' ? 'items-center' : 'items-start',
        BACKDROPS[backdrop],
        className,
      )}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div className="contents" onClick={(e) => e.stopPropagation()}>
        <EscapeDepthContext.Provider value={depth + 1}>{children}</EscapeDepthContext.Provider>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The panel that sits inside an overlay: fixed width capped at the viewport, a
 * bordered header with title (and optional subtitle), and a right-aligned
 * bordered footer for the buttons.
 *
 * Deliberately separate from `ModalOverlay` — the extension dialog host runs
 * its own portal for arrow-key navigation, and it still wants this chrome.
 */
export function ModalPanel({
  width,
  title,
  subtitle,
  footer,
  children,
}: {
  /** Panel width in px; `max-w-[92vw]` still wins on a narrow window. */
  width: number
  title?: React.ReactNode
  subtitle?: React.ReactNode
  /** Button row under a top border, right-aligned. */
  footer?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      style={{ width }}
      className="border-border bg-surface-raised max-w-[92vw] overflow-hidden rounded-xl border shadow-2xl"
    >
      {title !== undefined && (
        <div className="border-border border-b px-4 py-3">
          <div className="text-lg font-semibold">{title}</div>
          {subtitle !== undefined && (
            <div className="text-text-tertiary mt-0.5 text-sm">{subtitle}</div>
          )}
        </div>
      )}
      {children}
      {footer !== undefined && (
        <div className="border-border flex justify-end gap-2 border-t px-4 py-2.5">{footer}</div>
      )}
    </div>
  )
}
