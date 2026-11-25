/** Human-friendly relative time ("2 minutes ago"), shared across surfaces. */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(ms).toLocaleDateString()
}

/** Compact form for dense lists ("2m", "3h", "5d"). */
export function relativeTimeShort(ms: number): string {
  const diff = Date.now() - ms
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

/** Absolute timestamp for tooltips. */
export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** Clock time for a transcript row: `2:14 PM`, in the reader's 12/24-hour locale. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Local midnight — the boundary a day divider sits on. */
function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * True when the two instants fall on different local calendar days.
 *
 * The day, not the minute, is what a reader orients on, and `startOfDay`
 * makes 23:59 and 00:01 a boundary while a 5-minute gap on one day is not.
 * `Math.round` absorbs the 23/25-hour days around a DST change.
 */
export function isSameLocalDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

/**
 * Day-divider label: `Today`, `Yesterday`, `Tue, Mar 3`, or `Mar 3, 2025`.
 *
 * Relative for the two days a reader still holds in their head, dated beyond
 * them, and the year appears only when it differs — a transcript that spans a
 * new year must not read as if last March were this March.
 */
export function dayLabel(ms: number, now: number = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(
    [],
    sameYear
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' },
  )
}
