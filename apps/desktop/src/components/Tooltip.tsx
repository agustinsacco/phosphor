import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { formatShortcut } from '@/lib/shortcuts'
import { useEscapeKey } from './Modal'

export const TOOLTIP_DELAY = 650
const CLOSE_GRACE = 100
/** A label derived from visible content is capped; the content itself stays visible. */
const DERIVED_LABEL_MAX = 80
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

export type ActionHint =
  | string
  | {
      label: string
      description?: string
      shortcut?: readonly string[]
    }

/** Explicit opt-in, also usable on links, switches, summaries and custom rows. */
export function tooltipProps(hint: ActionHint | undefined) {
  // Older controls already format their shortcut. Keep it, but give it the
  // same quiet kbd treatment as new structured hints, not parenthetical prose.
  const chord =
    typeof hint === 'string'
      ? /^(.*?) \(((?:[⌘⌃⌥⇧⏎]|Ctrl|Alt|Shift|Esc|Enter|F\d)[^()]*)\)$/.exec(hint)
      : null
  const value =
    typeof hint === 'string'
      ? { label: chord?.[1] ?? hint, shortcut: chord ? [chord[2]!] : undefined }
      : hint
  return {
    'data-tooltip': value?.label || undefined,
    'data-tooltip-description': value?.description,
    'data-tooltip-shortcut': value?.shortcut ? formatShortcut(...value.shortcut) : undefined,
  }
}

/** Read the supplied React label, never the DOM or a custom component's output. */
export function actionLabel(children: React.ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child)
      if (
        isValidElement<{ children?: React.ReactNode; 'aria-hidden'?: boolean | 'true' | 'false' }>(
          child,
        ) &&
        (typeof child.type === 'string' || child.type === Fragment) &&
        child.type !== 'svg' &&
        child.props['aria-hidden'] !== true &&
        child.props['aria-hidden'] !== 'true'
      )
        return actionLabel(child.props.children)
      return ''
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Unstyled native button. Refs, events, semantics and layout belong to the caller. */
export function TooltipButton({
  tooltip,
  title,
  children,
  ...props
}: React.ComponentPropsWithRef<'button'> & { tooltip?: ActionHint | false }): React.JSX.Element {
  const text = actionLabel(children)
  const shortText =
    text.length > DERIVED_LABEL_MAX ? `${text.slice(0, DERIVED_LABEL_MAX - 1).trimEnd()}…` : text
  const explicit = typeof tooltip === 'string' ? tooltip : tooltip ? tooltip.label : undefined
  const name = props['aria-label'] || text || title || explicit || undefined
  const hint =
    tooltip === false ? undefined : (tooltip ?? title ?? (props['aria-label'] || shortText))
  // Native `title` used to name icon-only buttons. Mirror that fallback from
  // what actually rendered, so a custom child component's text keeps winning.
  const fallbackName = props['aria-label'] ? undefined : (title ?? explicit)
  const own = useRef<HTMLButtonElement | null>(null)
  const forwarded = props.ref
  const ref = useCallback(
    (node: HTMLButtonElement | null) => {
      own.current = node
      if (typeof forwarded === 'function') forwarded(node)
      else if (forwarded) forwarded.current = node
    },
    [forwarded],
  )
  useLayoutEffect(() => {
    const node = own.current
    if (!node || props['aria-label'] !== undefined) return
    if (fallbackName && !node.textContent?.trim()) node.setAttribute('aria-label', fallbackName)
    else node.removeAttribute('aria-label')
  })
  return (
    <button
      {...tooltipProps(hint)}
      {...props}
      ref={ref}
      aria-description={
        props['aria-description'] ??
        (typeof hint === 'object' ? hint.description : undefined) ??
        (title && title !== name ? title : undefined)
      }
    >
      {children}
    </button>
  )
}

/** Native labels and disclosures keep their semantics and existing layout. */
export function TooltipLabel({
  children,
  ...props
}: React.ComponentPropsWithRef<'label'>): React.JSX.Element {
  return (
    <label {...tooltipProps(actionLabel(children))} {...props}>
      {children}
    </label>
  )
}

export function TooltipSummary({
  children,
  ...props
}: React.ComponentPropsWithRef<'summary'>): React.JSX.Element {
  return (
    <summary {...tooltipProps(actionLabel(children))} {...props}>
      {children}
    </summary>
  )
}

function menuOpen(target: HTMLElement): boolean {
  return !!target.closest('[aria-haspopup][aria-expanded="true"], [data-tooltip-open="true"]')
}

interface OpenHint {
  target: HTMLElement
  label: string
  description?: string
  shortcut?: string
}

function readHint(target: HTMLElement): OpenHint | null {
  const label = target.dataset.tooltip
  return label
    ? {
        target,
        label,
        description: target.dataset.tooltipDescription,
        shortcut: target.dataset.tooltipShortcut,
      }
    : null
}

/**
 * One window-local host. Delegation only reads explicitly supplied data-tooltip
 * attributes: no title interception, DOM-label scraping, or per-row listeners.
 * Portals (menus/modals) participate without wrappers changing their layout.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState<OpenHint | null>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const dismiss = useRef<() => void>(() => {})
  const id = useId()
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // A hint is above its owning modal/menu in the existing Escape stack.
  useEscapeKey(() => dismiss.current(), open !== null, 'tooltip')

  useEffect(() => {
    let target: HTMLElement | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    let keyboard = false
    let windowActive = true
    let focusOwned = false
    let suppressed = false
    let shown = false
    const clearTimers = (): void => {
      clearTimeout(timer)
      timer = undefined
      clearTimeout(closeTimer)
    }
    const close = (): void => {
      clearTimers()
      setOpen(null)
      shown = false
      suppressed = true // No reopening until a fresh entry/focus.
    }
    dismiss.current = close
    const candidate = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? node.closest<HTMLElement>('[data-tooltip]') : null
    const insideBubble = (node: EventTarget | null): boolean =>
      node instanceof Node && !!bubble.current?.contains(node)
    const enter = (next: HTMLElement | null, focused: boolean): void => {
      if (next === target && !focused) {
        clearTimeout(closeTimer)
        if (shown || suppressed || timer !== undefined) return
      }
      clearTimers()
      setOpen(null)
      shown = false
      target = next
      focusOwned = focused
      suppressed = false
      if (!next) return
      const show = (): void => {
        timer = undefined
        if (!suppressed && next.isConnected && !menuOpen(next)) {
          shown = true
          setPosition(null)
          setOpen(readHint(next))
        }
      }
      if (focused) show()
      else timer = setTimeout(show, TOOLTIP_DELAY)
    }
    const over = (event: PointerEvent): void => {
      if (!windowActive || event.pointerType === 'touch' || event.buttons) return
      if (insideBubble(event.target)) {
        clearTimeout(closeTimer)
        return
      }
      const next = candidate(event.target)
      if (!next || (focusOwned && next === target)) return
      focusOwned = false
      enter(next, false)
    }
    const out = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || focusOwned) return
      if (
        insideBubble(event.relatedTarget) ||
        (target && candidate(event.relatedTarget) === target)
      )
        return
      clearTimeout(timer)
      timer = undefined
      clearTimeout(closeTimer)
      closeTimer = setTimeout(() => {
        close()
        target = null
      }, CLOSE_GRACE)
    }
    const focus = (event: FocusEvent): void => {
      if (windowActive && keyboard) enter(candidate(event.target), true)
    }
    const blur = (): void => {
      close()
      target = null
      focusOwned = false
    }
    const down = (): void => {
      keyboard = false
      focusOwned = false
      close()
    }
    const key = (event: KeyboardEvent): void => {
      // Only Tab navigation earns instant focus hints. Typing, then having the
      // app move focus programmatically, must not pop a hint.
      if (!MODIFIER_KEYS.has(event.key)) keyboard = event.key === 'Tab'
      // Leave a visible hint registered until the shared Escape dispatcher
      // consumes the event. Native discrete events can flush React between
      // listeners; closing here would expose the underlying modal to that Esc.
      if (event.key !== 'Escape' || !shown) close()
    }
    // Only a scroll that moves the target counts. Streaming autoscroll in the
    // transcript must not keep cancelling a hint on the composer's buttons.
    const scroll = (event: Event): void => {
      const scroller = event.target
      if (
        target &&
        // A window or document scroll moves everything; an element scroll
        // matters only when it contains the target.
        (!(scroller instanceof Node) || scroller instanceof Document || scroller.contains(target))
      )
        close()
    }
    const windowBlur = (): void => {
      windowActive = false
      blur()
    }
    const windowFocus = (): void => {
      windowActive = true
    }
    const visibility = (): void => {
      if (document.hidden) windowBlur()
      else windowFocus()
    }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', out)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', blur)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('click', close, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', windowBlur)
    window.addEventListener('focus', windowFocus)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      clearTimers()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', out)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', blur)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('click', close, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', windowBlur)
      window.removeEventListener('focus', windowFocus)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  useEffect(() => {
    if (!open || !bubble.current) return
    const { target } = open
    const floating = bubble.current
    let live = true
    const update = (): void => {
      if (!target.isConnected) {
        dismiss.current()
        return
      }
      void computePosition(target, floating, {
        strategy: 'fixed',
        placement: 'top',
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (live) setPosition({ left: x, top: y })
      })
    }
    const stop = autoUpdate(target, floating, update)
    // Observe only while visible, for teardown/changed metadata, not discovery.
    const observer = new MutationObserver((records) => {
      const obscured = records.some((record) =>
        [...record.addedNodes].some(
          (node) =>
            node instanceof Element &&
            !node.contains(target) &&
            (node.matches('[data-modal-overlay], [data-shortcut-overlay]') ||
              node.querySelector('[data-modal-overlay], [data-shortcut-overlay]')),
        ),
      )
      if (
        obscured ||
        !target.isConnected ||
        target.dataset.tooltip !== open.label ||
        target.dataset.tooltipDescription !== open.description ||
        target.dataset.tooltipShortcut !== open.shortcut ||
        menuOpen(target)
      )
        dismiss.current()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    observer.observe(target, { attributes: true })
    const described = target.getAttribute('aria-describedby')
    const describe = open.label !== target.getAttribute('aria-label') || !!open.description
    if (describe) target.setAttribute('aria-describedby', [described, id].filter(Boolean).join(' '))
    return () => {
      live = false
      stop()
      observer.disconnect()
      // Preserve descriptions another owner added while the hint was open.
      if (describe) {
        const remaining = target
          .getAttribute('aria-describedby')
          ?.split(/\s+/)
          .filter((part) => part !== id)
          .join(' ')
        if (remaining) target.setAttribute('aria-describedby', remaining)
        else target.removeAttribute('aria-describedby')
      }
    }
  }, [open, id])

  return (
    <>
      {children}
      {open &&
        createPortal(
          <div
            ref={bubble}
            id={id}
            role="tooltip"
            className="action-tooltip"
            style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
          >
            <div className="flex items-center gap-3">
              <span className="min-w-0 break-words">{open.label}</span>
              {open.shortcut && (
                <kbd className="text-text-secondary shrink-0 font-mono text-sm">
                  {open.shortcut}
                </kbd>
              )}
            </div>
            {open.description && (
              <div className="text-text-secondary mt-0.5">{open.description}</div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
