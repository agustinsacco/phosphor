import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import { autoUpdate, computePosition, offset, flip, shift, size } from '@floating-ui/dom'

/** Viewport-fit menus escape scroll containers without losing their anchor. */
export function useAnchoredMenu(
  trigger: RefObject<HTMLElement | null> | undefined,
  menu: RefObject<HTMLElement | null>,
  enabled: boolean,
  above: boolean,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({})
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
  return style
}
