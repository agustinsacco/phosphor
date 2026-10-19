/**
 * Parser for `claude -p /usage --output-format json`, shared by Desktop's main
 * process and the Host. Pure: no spawn, no Node APIs.
 *
 * The CLI's own `/usage` panel is fed by Anthropic's internal
 * `GET /api/oauth/usage` endpoint — the same numbers Claude Desktop shows,
 * live, at any percentage. The rendered text is a wire contract in the same
 * sense as the `[Claude Code · …]` markers: parsed narrowly, and any line
 * Phosphor doesn't recognise is ignored rather than guessed at. If the shape
 * drifts so far that nothing parses, the caller gets `no-usage` — never a
 * wrong number.
 *
 * Reset stamps are parsed in the local timezone of the machine that ran the
 * CLI, so a Host parses its own output before sending absolute times.
 */
import type { ClaudeUsageSnapshot, ClaudeUsageWindow } from './models'

/** Month names as the CLI prints them (en-US, "Aug 30 at 2:49pm"). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A usage line: `<label>: <n>% used` with an optional
 * `· resets <MMM D at h:mm(am|pm)> (<tz>)`. Narrow on purpose — the labels
 * themselves are an open set ("Current week (Fable)", "One-time credit ·
 * Expires …"), so the label passes through and only the shape is enforced.
 */
const WINDOW_LINE = /^(.+?): (\d+)% used(?: · resets ([^·]+?))?(?: \([^)]+\))?$/

/** The CLI's honesty flags, surfaced in the snapshot instead of papered over. */
const LAST_KNOWN_MARKER = /Showing last-known usage/
const REFRESH_FAILED_MARKER = /Could not refresh usage data/

/** Where the behavioral context begins, if the CLI included it (both apostrophes seen in the wild). */
const CONTRIBUTING_HEADING = /^What['\u2019]s contributing to your limits usage\?$/

/**
 * Parse the CLI's reset stamp in the machine's local timezone.
 *
 * "Aug 30 at 2:49pm", or "Oct 19, 6:29am" as Claude Code 2.1.283 prints it —
 * no year, because the CLI renders a human stamp. The
 * year is inferred as the first candidate (this year, then next) that lands
 * in the future, which handles the December→January rollover; a valid shape
 * therefore almost always yields a future instant. The renderer still
 * guards with its own "past reset ⇒ no countdown" rule
 * (`resetLabel` in `composer/rateLimit.ts`).
 */
export function parseResetStamp(text: string, nowMs: number = Date.now()): number | null {
  const match = /^([A-Z][a-z]{2}) (\d{1,2})(?: at|,) (\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(
    text.trim(),
  )
  if (!match) return null
  const monthName = match[1]
  const dayText = match[2]
  const hourText = match[3]
  const minuteText = match[4]
  const meridiem = match[5]
  if (monthName === undefined || dayText === undefined || hourText === undefined) return null
  const month = MONTHS.indexOf(monthName)
  const day = Number(dayText)
  if (month === -1 || day < 1 || day > 31) return null
  let hour = Number(hourText) % 12
  if (meridiem === 'pm') hour += 12
  const minute = minuteText ? Number(minuteText) : 0

  const now = new Date(nowMs)
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    const at = new Date(year, month, day, hour, minute, 0, 0).getTime()
    if (Number.isFinite(at) && at > nowMs) return at
  }
  return null
}

/** Window family from the CLI's rendered label. */
export function windowKind(label: string): ClaudeUsageWindow['kind'] {
  if (label === 'Current session') return 'five_hour'
  if (label === 'Current week (all models)') return 'weekly'
  if (/^Current week \((.+)\)$/.test(label)) return 'weekly_model'
  return 'other'
}

/**
 * Parse the `result` text of one `/usage` run into a snapshot.
 *
 * Returns null when no usage line parses at all — signed out, API-key auth,
 * or a format drift; all three must render as "no data", not as zeros.
 */
export function parseUsageText(
  text: string,
  nowMs: number = Date.now(),
): ClaudeUsageSnapshot | null {
  const lines = text.split('\n')
  const windows: ClaudeUsageWindow[] = []
  let stale = false
  let contributing: string | null = null

  const headingIndex = lines.findIndex((line) => CONTRIBUTING_HEADING.test(line.trim()))
  const windowLines = headingIndex === -1 ? lines : lines.slice(0, headingIndex)
  if (headingIndex !== -1) {
    const block = lines
      .slice(headingIndex + 1)
      .join('\n')
      .trim()
    if (block) contributing = block
  }

  for (const line of windowLines) {
    if (LAST_KNOWN_MARKER.test(line)) {
      stale = true
      continue
    }
    if (REFRESH_FAILED_MARKER.test(line)) continue
    const match = WINDOW_LINE.exec(line.trim())
    if (!match) continue
    const label = match[1]?.trim()
    const percentText = match[2]
    const resetText = match[3]
    // Both capture groups are load-bearing; a match missing either is drift.
    if (!label || percentText === undefined) continue
    const percentUsed = Number(percentText)
    if (!Number.isFinite(percentUsed) || percentUsed < 0 || percentUsed > 200) continue
    windows.push({
      label,
      kind: windowKind(label),
      percentUsed,
      resetsAt: resetText ? parseResetStamp(resetText, nowMs) : null,
    })
  }

  if (windows.length === 0) return null
  return { fetchedAt: nowMs, stale, windows, contributing }
}

/** Parses the full `--output-format json` envelope of one run. */
export function parseUsageOutput(
  stdout: string,
  nowMs: number = Date.now(),
): ClaudeUsageSnapshot | null {
  try {
    const parsed = JSON.parse(stdout) as { result?: string }
    return typeof parsed.result === 'string' ? parseUsageText(parsed.result, nowMs) : null
  } catch {
    return null
  }
}
