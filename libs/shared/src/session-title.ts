/**
 * One place that decides what a session is *called*.
 *
 * pi only reports `sessionName` when it was set explicitly (`set_session_name`
 * or `pi --name`) — it never auto-titles. The sidebar always knew that and fell
 * back to the scanned session-file name or the first user message, but the chat
 * header read `sessionName` alone, so an active, clearly-titled thread still
 * said "New session" in the header while the sidebar showed its real subject.
 */

/** Default textual elision; surfaces with CSS clamping can request the full title. */
const MAX_TITLE = 80

export interface SessionTitleSources {
  /** Explicit name from pi (`get_state.sessionName` / scanned `session_info`). */
  explicitName?: string | null
  /** First user message text, from the transcript or the session scanner. */
  firstUserText?: string | null
}

/**
 * Resolve a display title, or `null` when nothing is known yet (callers choose
 * their own placeholder: "New session" in the header, "Untitled session" in the
 * sidebar list).
 */
export function sessionTitle(
  sources: SessionTitleSources,
  { elide = true }: { elide?: boolean } = {},
): string | null {
  const explicit = clean(sources.explicitName)
  const derived = clean(sources.firstUserText)
  const title = explicit ?? (derived ? firstLine(derived) : undefined)
  return title ? (elide ? truncateTitle(title) : title) : null
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Prompts are frequently multi-line (pasted logs, numbered lists). Titles use
 * the first non-empty line only, so the header can't grow or show fragments of
 * a code block.
 */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ?? text.trim()
}

function truncateTitle(text: string): string {
  if (text.length <= MAX_TITLE) return text
  // Slice by code points, not UTF-16 units: a string slice through the middle
  // of an astral character (emoji, CJK extensions) leaves a lone surrogate
  // that renders as mojibake right before the ellipsis.
  return `${[...text]
    .slice(0, MAX_TITLE - 1)
    .join('')
    .trimEnd()}…`
}
