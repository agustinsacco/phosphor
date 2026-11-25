/**
 * ↑/↓ prompt recall in the composer, the way Claude Code's terminal REPL does
 * it: ↑ from an empty prompt walks back through what you already sent, ↓ walks
 * forward, and stepping past the newest entry restores the draft you were
 * typing before you started browsing.
 *
 * The history itself is the session's own user messages — the transcript
 * already holds them in order, so there is no second copy to keep in sync and
 * a resumed session has its history immediately.
 *
 * `index` is an offset from the END of the list (0 = the most recent prompt);
 * `null` means "not browsing, the composer holds the live draft".
 */
export interface Recall {
  index: number | null
  text: string
}

/** ↑ — one step further back. Returns null at the oldest entry (no wrap). */
export function recallPrevious(history: readonly string[], index: number | null): Recall | null {
  if (history.length === 0) return null
  const next = index === null ? 0 : index + 1
  if (next >= history.length) return null
  return { index: next, text: history[history.length - 1 - next] as string }
}

/** ↓ — one step forward; from the newest entry back to the saved draft. */
export function recallNext(
  history: readonly string[],
  index: number | null,
  draft: string,
): Recall | null {
  if (index === null) return null
  if (index === 0) return { index: null, text: draft }
  const next = index - 1
  return { index: next, text: history[history.length - 1 - next] as string }
}

/**
 * The prompts this session has already sent, oldest first.
 *
 * Read straight off the transcript rather than kept as a second list: every
 * send appends a user item (optimistically, before pi echoes it), so the
 * transcript is already the history — and a session resumed from disk has one
 * without Phosphor persisting anything of its own.
 */
export function promptHistory(items: readonly { kind: string; text?: string }[]): string[] {
  const prompts: string[] = []
  for (const item of items) {
    if (item.kind !== 'user') continue
    const text = item.text?.trim()
    // Consecutive duplicates (a retried prompt) would make ↑ look stuck.
    if (text && text !== prompts[prompts.length - 1]) prompts.push(text)
  }
  return prompts
}
