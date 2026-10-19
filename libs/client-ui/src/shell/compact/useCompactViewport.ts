import { useEffect, useState } from 'react'
import type { Platform } from '@/platform/Platform'

/** Presentation only: crossing this width never enables native capabilities. */
export const EXPANDED_CLIENT_WIDTH = 900
const currentFactor = (): Platform['formFactor'] =>
  window.innerWidth >= EXPANDED_CLIENT_WIDTH ? 'expanded' : 'compact'

/** Visual viewport follows the on-screen keyboard; safe areas remain CSS-owned. */
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
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return formFactor
}
