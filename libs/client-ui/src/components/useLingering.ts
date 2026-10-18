import { useEffect, useState } from 'react'

/**
 * Keep showing the last non-null value for `ms` after it goes null, so a
 * surface driven by store state can play an exit animation instead of
 * vanishing on the frame the state clears.
 *
 * A new value always wins immediately — including one that arrives while the
 * previous one is still leaving.
 */
export function useLingering<T>(
  value: T | null,
  ms: number,
): { value: T | null; leaving: boolean } {
  const [last, setLast] = useState<T | null>(value)
  // Derived during render rather than in an effect, so the first frame of a
  // new value is never a frame of the old one.
  if (value !== null && value !== last) setLast(value)
  useEffect(() => {
    if (value !== null || last === null) return
    const handle = setTimeout(() => setLast(null), ms)
    return () => clearTimeout(handle)
  }, [value, last, ms])
  return value !== null ? { value, leaving: false } : { value: last, leaving: last !== null }
}
