import {
  createElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { autoUpdate, computePosition, offset, flip, shift, size } from '@floating-ui/dom'

/**
 * Until floating-ui answers (it is async), an enabled menu sits fixed at the
 * viewport's corner, invisible and inert. Left to its classes it would be a
 * portal below the viewport, and a child focusing on mount would make Chromium
 * scroll <body> to reveal it: overflow: hidden stops users, not focus.
 */
const PENDING: CSSProperties = Object.freeze({
  position: 'fixed',
  left: 0,
  top: 0,
  right: 'auto',
  bottom: 'auto',
  margin: 0,
  transform: 'none',
  opacity: 0,
  pointerEvents: 'none',
})

/** Viewport-fit menus escape scroll containers without losing their anchor. */
export function useAnchoredMenu(
  trigger: RefObject<HTMLElement | null> | undefined,
  menu: RefObject<HTMLElement | null>,
  enabled: boolean,
  above: boolean,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties | null>(null)
  useEffect(() => {
    const reference = trigger?.current
    const floating = menu.current
    if (!enabled || !reference || !floating) return
    let current = true
    const update = (): void => {
      void computePosition(reference, floating, {
        strategy: 'fixed',
        placement: above ? 'top-start' : 'bottom-start',
        middleware: [
          offset(6),
          flip({ padding: 8 }),
          shift({ padding: 8 }),
          size({
            padding: 8,
            apply({ availableHeight }) {
              floating.style.maxHeight = `${Math.max(44, availableHeight)}px`
            },
          }),
        ],
      })
        .then(({ x, y }) => {
          if (current)
            setStyle({
              position: 'fixed',
              left: x,
              top: y,
              right: 'auto',
              bottom: 'auto',
              margin: 0,
              transform: 'none',
              zIndex: 100,
              maxWidth: 'calc(100vw - 16px)',
            })
        })
        .catch(() => undefined)
    }
    const detach = autoUpdate(reference, floating, update, {
      elementResize: typeof ResizeObserver !== 'undefined',
    })
    return () => {
      current = false
      detach()
    }
  }, [trigger, menu, enabled, above])
  return style ?? (enabled ? PENDING : {})
}

/**
 * A phone sheet that opens upward stays above the place it opened from (the
 * composer, for `/` and `@`), never over it: pinned to the screen bottom, it
 * covered Send, and Return on a soft keyboard adds a line instead. Returns
 * the sheet's bottom offset and the room above it, both following the keyboard,
 * and a marker to render in place, whose parent is the box measured.
 */
export function useCompactLift(enabled: boolean): [CSSProperties, ReactNode] {
  const marker = useRef<HTMLSpanElement>(null)
  const [style, setStyle] = useState<CSSProperties>({})
  useEffect(() => {
    if (!enabled) return
    const viewport = window.visualViewport
    const update = (): void => {
      const container = marker.current?.parentElement
      if (!container) return
      const top = container.getBoundingClientRect().top
      setStyle({
        ['--compact-menu-lift' as string]: `${Math.round(window.innerHeight - top + 8)}px`,
        maxHeight: Math.min(500, Math.max(96, Math.round(top - (viewport?.offsetTop ?? 0) - 16))),
      })
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [enabled])
  return [style, enabled ? createElement('span', { ref: marker, hidden: true }) : null]
}
