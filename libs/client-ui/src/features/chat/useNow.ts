import { useEffect, useState } from 'react'

/**
 * One clock per surface for elapsed and quiet times. It ticks only while
 * something is running and the window is visible, and never drives polling.
 */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, intervalMs)
    return () => clearInterval(timer)
  }, [enabled, intervalMs])
  return now
}
