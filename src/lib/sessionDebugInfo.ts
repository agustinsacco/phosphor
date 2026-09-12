/**
 * A copyable pointer to everything a session wrote to disk.
 *
 * Debugging a pi session after the fact means reading two ledgers, not one:
 *
 *   - pi's own transcript, which carries per-message `usage` (the authoritative
 *     token and cost numbers), and
 *   - the provider's transcript, when the session ran on the Claude Code CLI.
 *     The CLI keeps its own parallel copy of the conversation, and comparing
 *     the two is what exposes duplication — a pi transcript of 473 KB against
 *     a CLI copy of 13.8 MB is the whole diagnosis of a re-send bug.
 *
 * Both live under mangled directory names that are tedious to derive by hand,
 * and the two harnesses mangle differently. This produces the paths and the
 * ids in one block, so "here's my session" is a paste rather than an
 * archaeology exercise.
 */

import { claudeProjectDirName } from '@shared/claude-paths'

// Re-exported: the CLI's mangling is shared with the main process now, but
// this module is where callers already reach for it.
export { claudeProjectDirName }

export interface SessionDebugSource {
  /** pi's session file (.jsonl), absolute. */
  path: string
  /** pi's session id. */
  sessionId: string
  /** The session's own working directory. */
  cwd: string
  provider?: string
  model?: string
  /**
   * The Claude Code CLI's own session id, from the provider's sidecar map
   * (`sessions:claudeSessionId`).
   *
   * NOT the pi session id. It used to be — pi passed its id through to
   * `claude --session-id` — but observer mode gives the CLI a session of its
   * own and records the pairing. Deriving the path from the pi id printed a
   * file that has never existed, in the one block whose entire job is to be
   * pasted into a bug report and opened by someone else.
   */
  claudeSessionId?: string | null
}

/**
 * pi mangles a cwd to `--home-user-project--`: one leading separator dropped,
 * then every `/`, `\\` and `:` becomes a dash, wrapped in double dashes — so
 * `C:\\Users\\dev\\proj` is `--C--Users-dev-proj--`. Mirrors
 * `electron/pi/pi-paths.ts`, which is the source of truth on the main side;
 * this is the renderer's read-only copy for display, so it deliberately does
 * not resolve symlinks (it has no fs access and the value is a pointer for a
 * human, not a lookup key).
 */
export function piSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/**
 * Where the Claude Code CLI keeps its copy of this conversation.
 *
 * Returns null for sessions that did not run on that provider — there is no
 * such file, and pointing at a path that cannot exist is worse than saying
 * nothing. `~` rather than an absolute home path: the block is for pasting,
 * and the reader's home is not necessarily the writer's.
 */
export function claudeSessionPath(source: SessionDebugSource): string | null {
  if (source.provider !== 'pi-claude-cli') return null
  // No mapping means the session predates observer mode, where the two ids
  // really were the same. A miss is a path that may not exist; a WRONG id is
  // a path that cannot.
  const id = source.claudeSessionId ?? source.sessionId
  return `~/.claude/projects/${claudeProjectDirName(source.cwd)}/${id}.jsonl`
}

/**
 * Format the block that gets copied.
 *
 * Plain `key: value` lines rather than JSON: this is pasted into a chat
 * message, where it needs to survive being read by a person as readily as by
 * a tool.
 */
export function formatSessionDebugInfo(source: SessionDebugSource): string {
  const lines = [
    'pi session',
    `  id:       ${source.sessionId}`,
    `  cwd:      ${source.cwd}`,
    `  file:     ${source.path}`,
  ]
  if (source.provider) {
    lines.push(`  provider: ${source.provider}${source.model ? ` / ${source.model}` : ''}`)
  }
  const cli = claudeSessionPath(source)
  if (cli) {
    lines.push(`  claude:   ${cli}`)
  }
  return lines.join('\n')
}
