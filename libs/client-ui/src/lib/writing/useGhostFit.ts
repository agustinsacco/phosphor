import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fitGhost, ghostVisibility } from './fitGhost'

/**
 * The autocomplete ghost text a composer field can show, cut to what fits.
 *
 * The field grows with the text, not the suggestion, so a long suggestion
 * wraps below it and is clipped. It is cut to the whole words that show
 * (`fitGhost`), measured once per value, suggestion and field size, and
 * what is shown is exactly what Tab inserts.
 *
 * The mirror wraps and scrolls exactly as the textarea does: same classes,
 * plus the textarea's live scroll offset and scrollbar width. The suggestion
 * is measured in it before paint, so a clipped one never shows.
 */
export function useGhostFit(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  suggestion: string | null,
  expanded: boolean,
): {
  ghost: string | null
  mirrorRef: React.RefObject<HTMLDivElement | null>
  ghostRef: React.RefObject<HTMLSpanElement | null>
} {
  const mirrorRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLSpanElement>(null)
  const [fit, setFit] = useState<{ key: string; shown: string | null } | null>(null)
  const [widthChanges, setWidthChanges] = useState(0)
  const fitKey =
    suggestion === null ? null : `${expanded}|${widthChanges}|${value}\u0000${suggestion}`
  const ghost = fitKey !== null && fit?.key === fitKey ? fit.shown : suggestion

  useLayoutEffect(() => {
    const el = textareaRef.current
    const mirror = mirrorRef.current
    if (!el || !mirror) return
    const style = getComputedStyle(el)
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
    const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - (borders || 0))
    mirror.style.paddingRight = `${parseFloat(style.paddingRight) + scrollbar}px`
    mirror.scrollTop = el.scrollTop
    if (fitKey === null || suggestion === null || fit?.key === fitKey) return
    const visible = ghostVisibility(mirror, ghostRef.current?.firstChild ?? null)
    if (visible) setFit({ key: fitKey, shown: fitGhost(suggestion, visible) })
  })

  // A narrower field wraps sooner: measure again when the width changes.
  const showing = suggestion !== null
  useEffect(() => {
    const el = textareaRef.current
    if (!el || !showing) return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      setWidthChanges((n) => n + 1)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [textareaRef, showing])

  return { ghost, mirrorRef, ghostRef }
}
