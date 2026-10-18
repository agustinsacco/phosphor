import { useEffect } from 'react'

/** Visual viewport follows the on-screen keyboard; safe areas remain CSS-owned. */
export function useCompactViewport(): void {
  useEffect(() => {
    const root = document.documentElement
    const previous = root.dataset.formFactor
    root.dataset.formFactor = 'compact'
    const viewport = window.visualViewport
    const update = (): void => {
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
}
