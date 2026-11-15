import { useCallback, useEffect, useState } from 'react'
import type { BrainLink } from '@shared/brain'
import { initialTrail, moveTrail, visitTrail, type BrainVisit } from './trail'

export function useExplorer() {
  const [trail, setTrail] = useState(initialTrail)
  const [review, setReview] = useState<string | null>(null)
  const [extraction, setExtraction] = useState<string | null>(null)
  const [path, setPath] = useState<BrainLink[] | null>(null)
  const [query, setQuery] = useState('')
  const clearPanels = useCallback((): void => {
    setReview(null)
    setExtraction(null)
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
  const jump = (index: number): void => {
    setTrail((old) => ({ ...old, index }))
    clearPanels()
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      if (
        event.defaultPrevented ||
        target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')
      )
        return
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
  }, [move, query])
  return {
    trail,
    visit: trail.items[trail.index],
    review,
    extraction,
    path,
    onVisit,
    move,
    jump,
    setReview,
    setExtraction,
    setPath,
    setQuery,
  }
}
export type ExplorerState = ReturnType<typeof useExplorer>
