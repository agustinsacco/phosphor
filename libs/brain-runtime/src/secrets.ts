// No shared secret scrubber exists in the portable libraries. Match on the full
// segment before cutting excerpts so a window cannot expose part of a credential.
const SECRETS = [
  /(?<![\w])\+\d{1,3}(?:[ .()-]*\d){8,12}(?![\w])/g,
  /(?<![\w])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}|\d{3}[ .-]\d{3}[ .-]\d{4})(?!\d)/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]?-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b/g,
  /\bBearer\s+[^\s"'<>]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:password|token)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s"'<>]+/gi,
  /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}\b/gi,
]

export function scrubExcerpt(text: string, start = 0, end = text.length): string {
  const ranges = SECRETS.flatMap((pattern) =>
    Array.from(text.matchAll(pattern), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })),
  )
    .filter((r) => r.end > start && r.start < end)
    .sort((a, b) => a.start - b.start)
  let cursor = start
  let result = ''
  for (const range of ranges) {
    if (range.end <= cursor) continue
    result += text.slice(cursor, Math.max(cursor, range.start)) + '[redacted]'
    cursor = Math.min(end, range.end)
  }
  return result + text.slice(cursor, end)
}
