import { useEffect, useState } from 'react'
import type { Platform } from '@/platform/Platform'

/** Presentation only: crossing this width never enables native capabilities. */
export const EXPANDED_CLIENT_WIDTH = 900
const currentFactor = (): Platform['formFactor'] =>
  window.innerWidth >= EXPANDED_CLIENT_WIDTH ? 'expanded' : 'compact'

/**
 * How much of the page's bottom an on-screen keyboard covers, in CSS pixels.
 *
 * iOS, and Android without `interactive-widget=resizes-content`, shrink only the
 * visual viewport, so the layout viewport's remainder below it is the keyboard.
 * A pinch zoom shrinks the visual viewport too and is not a keyboard.
 */
export function keyboardInset(
  layoutHeight: number,
  viewport: Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'> | null | undefined,
): number {
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return 0
  return Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop))
}

/**
 * Visual viewport follows the on-screen keyboard. Safe areas stay CSS-owned;
 * `--compact-keyboard` lets CSS drop the bottom one while the keyboard covers it.
 */
export function useCompactViewport(): Platform['formFactor'] {
  const [formFactor, setFormFactor] = useState(currentFactor)
  useEffect(() => {
    const root = document.documentElement
    const previous = root.dataset.formFactor
    const viewport = window.visualViewport
    const update = (): void => {
      const next = currentFactor()
      root.dataset.formFactor = next
      setFormFactor(next)
      root.style.setProperty('--compact-height', `${viewport?.height ?? window.innerHeight}px`)
      root.style.setProperty('--compact-top', `${viewport?.offsetTop ?? 0}px`)
      root.style.setProperty(
        '--compact-keyboard',
        `${keyboardInset(root.clientHeight, viewport)}px`,
      )
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      if (previous === undefined) delete root.dataset.formFactor
      else root.dataset.formFactor = previous
      root.style.removeProperty('--compact-height')
      root.style.removeProperty('--compact-top')
      root.style.removeProperty('--compact-keyboard')
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return formFactor
}
