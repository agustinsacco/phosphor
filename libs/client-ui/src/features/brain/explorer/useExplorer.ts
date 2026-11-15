import { useCallback, useEffect, useState } from 'react'
import type { BrainLink } from '@shared/brain'
import { shortcutOverlayOpen } from '@/lib/shortcutContext'
import { initialTrail, moveTrail, visitTrail, type BrainVisit } from './trail'

export function useExplorer() {
  const [trail, setTrail] = useState(initialTrail)
  const [path, setPath] = useState<BrainLink[] | null>(null)
  const [query, setQuery] = useState('')
  const clearPanels = useCallback((): void => {
    setPath(null)
  }, [])
  const onVisit = useCallback(
    (next: BrainVisit): void => {
      setTrail((old) => visitTrail(old, next))
      clearPanels()
    },
    [clearPanels],
  )
  const move = useCallback(
    (delta: number): void => {
      setTrail((old) => moveTrail(old, delta))
      clearPanels()
    },
    [clearPanels],
  )
  const jump = useCallback(
    (index: number): void => {
      setTrail((old) => ({ ...old, index }))
      clearPanels()
    },
    [clearPanels],
  )
  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      if (
        event.defaultPrevented ||
        event.isComposing ||
        shortcutOverlayOpen() ||
        target.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
        )
      )
        return
      if (event.key === 'Escape' && trail.index >= 0) {
        event.preventDefault()
        jump(-1)
        return
      }
      const delta =
        event.altKey && event.key === 'ArrowRight'
          ? 1
          : (event.altKey && event.key === 'ArrowLeft') || (event.key === 'Backspace' && !query)
            ? -1
            : 0
      if (delta) {
        event.preventDefault()
        move(delta)
      }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [move, query, jump, trail.index])
  return {
    trail,
    visit: trail.items[trail.index],
    path,
    onVisit,
    move,
    jump,
    setPath,
    setQuery,
  }
}
export type ExplorerState = ReturnType<typeof useExplorer>
