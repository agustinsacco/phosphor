/** Electron/Chromium's insertText preserves the native undo buffer; assigning
 * textarea.value does not. Only plain text, never insertHTML. The controlled
 * caller still applies the requested value when this deprecated API is absent.
 */
export function recordTextareaEdit(el: HTMLTextAreaElement, value: string): void {
  const before = el.value
  if (before === value || typeof el.ownerDocument.execCommand !== 'function') return
  let from = 0
  let to = before.length
  let nextTo = value.length
  while (from < to && from < nextTo && before[from] === value[from]) from++
  // Never ask the browser to edit half an astral character.
  if (from > 0 && /[\uDC00-\uDFFF]/.test(before[from] ?? value[from] ?? '')) from--
  while (to > from && nextTo > from && before[to - 1] === value[nextTo - 1]) {
    to--
    nextTo--
  }
  if (/[\uDC00-\uDFFF]/.test(before[to] ?? '')) {
    to++
    nextTo++
  }
  el.focus()
  el.setSelectionRange(from, to)
  try {
    el.ownerDocument.execCommand('insertText', false, value.slice(from, nextTo))
  } catch {
    // Non-Chromium harnesses can reject it; React remains the value authority.
  }
}
