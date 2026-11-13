export const WINDOW_CHARS = 32_000
export const WINDOW_OVERLAP = 2
export const DOCUMENT_TOOL_CHARS = 4000
export const TOOL_HEAD = 600
export const TOOL_TAIL = 200
export const TOOL_ARGS_CHARS = 300
export const ANSWER_BYTES = 64 * 1024
export const CLAIM_BUDGET = 300
export const EXTRACT_CAP = 40
export const PARENT_CHARS = 24_000
export const ELISION = /\[… \d+ chars omitted …\]/u

export function truncateTool(text: string, limit = TOOL_HEAD + TOOL_TAIL + 80): string {
  if (text.length <= limit) return text
  const tail = limit === DOCUMENT_TOOL_CHARS ? 0 : TOOL_TAIL
  const head = limit === DOCUMENT_TOOL_CHARS ? limit - 80 : limit - tail - 80
  return `${text.slice(0, head)}[… ${text.length - head - tail} chars omitted …]${tail ? text.slice(-tail) : ''}`
}
