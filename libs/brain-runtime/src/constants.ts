export const WINDOW_CHARS = 300_000
export const WINDOW_OVERLAP = 2
export const ANSWER_BYTES = 64 * 1024
export const CLAIM_BUDGET = 300
export const MAX_PART_CLAIMS = 25
export const ELISION = /\[… \d+ chars omitted …\]/u

export function elideUser(text: string): string {
  if (text.length <= 6000) return text
  return `${text.slice(0, 4000)}[… ${text.length - 5900} chars omitted …]${text.slice(-1900)}`
}
