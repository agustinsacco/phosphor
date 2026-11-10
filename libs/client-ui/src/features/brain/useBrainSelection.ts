import { useState } from 'react'

/** Opening an extraction preserves its caller; Back restores that selection. */
export function useBrainSelection() {
  const [review, setReview] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [extraction, setExtraction] = useState<string | null>(null)
  const closeReview = (): void => setReview(null)
  const closeMemory = (): void => setSelected(null)
  const closeExtraction = (): void => setExtraction(null)
  const showMemory = (id: string): void => {
    setSelected(id)
    setReview(null)
    setExtraction(null)
  }
  const showReview = (id: string): void => {
    setReview(id)
    setExtraction(null)
  }
  const back = (): void => {
    if (extraction) setExtraction(null)
    else {
      setReview(null)
      setSelected(null)
    }
  }
  return {
    review,
    selected,
    extraction,
    showReview,
    showMemory,
    showExtraction: setExtraction,
    closeReview,
    closeMemory,
    closeExtraction,
    back,
  }
}
