import { useEffect, type RefObject } from 'react'
import type { PendingReveal } from '@/stores/files'

/**
 * Scroll a read-only code preview so `reveal`'s line sits mid-view, as the editor's reveal does.
 * Highlighted and plain code share one font and line height, so the offset is measured on the
 * `<pre>` either way, and the highlight arriving later does not move the line.
 */
export function useLineReveal(
  scroller: RefObject<HTMLElement | null>,
  reveal: PendingReveal | undefined,
  content: string,
): void {
  const line = reveal?.line
  const seq = reveal?.seq
  useEffect(() => {
    const box = scroller.current
    const code = box?.querySelector('pre')
    if (!box || !code || !line) return
    const style = getComputedStyle(code)
    const lineHeight = parseFloat(style.lineHeight)
    if (!Number.isFinite(lineHeight)) return
    const codeTop = code.getBoundingClientRect().top - box.getBoundingClientRect().top
    const lineTop = (parseFloat(style.paddingTop) || 0) + (line - 1) * lineHeight
    box.scrollTop += codeTop + lineTop - Math.max(0, box.clientHeight - lineHeight) / 2
  }, [scroller, line, seq, content])
}
