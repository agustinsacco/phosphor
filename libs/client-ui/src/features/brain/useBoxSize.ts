import { useEffect, useState } from 'react'

export interface BoxSize {
  width: number
  height: number
}

/** An element's content size from a ResizeObserver; `fallback` where none exists (tests). */
export function useBoxSize(ref: React.RefObject<HTMLElement | null>, fallback: BoxSize): BoxSize {
  const [size, setSize] = useState(fallback)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const width = Math.floor(entry.contentRect.width)
      const height = Math.floor(entry.contentRect.height)
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return size
}
