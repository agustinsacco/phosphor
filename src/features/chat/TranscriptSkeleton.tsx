/**
 * Placeholder shown while a session's history is being replayed from disk.
 *
 * Resuming a session is not instant — pi spawns, replays the file, and the
 * transcript arrives in a burst. Without this the chat rendered the "Describe
 * a task to begin" empty state for that whole window, which is actively wrong
 * for a session that has ten turns of history and reads as data loss before
 * the messages pop in.
 *
 * The bars approximate a transcript (alternating user/assistant blocks) so the
 * layout does not visibly jump when real content replaces them.
 */
export function TranscriptSkeleton({
  /**
   * Shown above the bars. A resume the user did not initiate (reopening a
   * session Phosphor suspended to reclaim memory) needs to say so — otherwise the
   * wait looks like the app being slow rather than a deliberate trade.
   */
  message = 'Restoring this session from disk…',
}: {
  message?: string
} = {}): React.JSX.Element {
  return (
    // Same column as the transcript it stands in for (mx-auto max-w-3xl px-6,
    // see MessageList) — full-width bars made the loading state look like a
    // different screen, then everything jumped inward when content landed.
    <div
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-hidden px-6 py-6"
      data-testid="transcript-skeleton"
      aria-busy="true"
      aria-label="Loading session history"
    >
      <div className="text-text-tertiary flex items-center gap-2 text-base">
        <span className="border-text-tertiary/40 border-t-text-tertiary h-3 w-3 animate-spin rounded-full border" />
        {message}
      </div>
      {SHAPES.map((shape, index) => (
        <div
          key={index}
          className={shape.user ? 'flex flex-col items-end gap-2' : 'flex flex-col gap-2'}
        >
          {shape.widths.map((width, line) => (
            <div
              key={line}
              className="skeleton h-3"
              // Staggered so the pulse reads as one sweep rather than a grid
              // of independently blinking bars.
              style={{ width, animationDelay: `${(index * 3 + line) * 90}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Rough transcript rhythm: a short prompt, then a longer reply. */
const SHAPES = [
  { user: true, widths: ['38%'] },
  { user: false, widths: ['92%', '86%', '54%'] },
  { user: true, widths: ['28%'] },
  { user: false, widths: ['88%', '72%'] },
]
