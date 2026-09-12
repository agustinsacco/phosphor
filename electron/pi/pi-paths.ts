import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectDirName } from '@shared/claude-paths'

/**
 * Single source of truth for pi's on-disk layout. Both the agent-settings
 * reader and the session scanner depend on the same env-var contract, so it
 * lives in one place rather than being restated per consumer.
 *
 * Layout (verified against the local install):
 *   ~/.pi/agent/sessions/--<cwd segments joined by dashes>--/<ts>_<uuid>.jsonl
 *
 * The Claude Code CLI's layout lives here too. A session on the
 * `pi-claude-cli` provider is written to disk TWICE — once by pi and once by
 * the CLI it shells out to — and the two harnesses mangle the same cwd
 * differently, so anything that has to find both ledgers needs both rules
 * side by side.
 */

/** pi's agent config directory, overridable for tests and alternate installs. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
}

/** Root directory holding one subdirectory of session files per workspace. */
export function piSessionsRoot(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR ?? join(piAgentDir(), 'sessions')
}

/**
 * pi-web-access's config file. Mirrors that package's own resolution
 * (utils.ts, verified at 0.24.0): PI_CODING_AGENT_DIR, then
 * XDG_CONFIG_HOME/pi, then ~/.pi — note the default is ~/.pi, NOT
 * ~/.pi/agent.
 */
export function webSearchConfigPath(): string {
  if (process.env.PI_CODING_AGENT_DIR) {
    return join(process.env.PI_CODING_AGENT_DIR, 'web-search.json')
  }
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'pi', 'web-search.json')
  }
  return join(homedir(), '.pi', 'web-search.json')
}

/**
 * `/Users/x/proj` → `--Users-x-proj--`; `C:\\Users\\x\\proj` → `--C--Users-x-proj--`.
 *
 * Transcribed from pi's own `getDefaultSessionDirPath` (session-manager.js,
 * verified at 0.85.1): strip ONE leading separator, then every `/`, `\\` and
 * `:` becomes a dash. The colon rule is what makes the Windows form — the
 * drive's `:` turns into a dash of its own, so `C:\\` yields `C--`. A
 * segments-split-and-join, which this used to be, produced `--C:-Users-…--`
 * on Windows: a directory pi never writes, so the sidebar listed no sessions.
 * The e2e stub duplicates this rule (`e2e/fixtures/pi-stub.cjs`); keep both
 * in step.
 */
export function sessionDirNameForCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/**
 * Both harnesses mangle the REAL path — symlinks resolved, so /var becomes
 * /private/var. pi resolves it itself; the CLI gets it for free because
 * `process.cwd()` in a spawned child is already resolved. Mangling an
 * unresolved path yields a directory name that simply does not exist.
 */
/**
 * Memoized, because `realCwd` is on the path of every session scan and every
 * session-dir watch — a blocking syscall on the main thread, repeated for the
 * same handful of workspaces for the life of the process.
 *
 * Only SUCCESSFUL resolutions are cached. A path that does not exist yet
 * resolves to itself, and caching that would permanently mis-resolve a
 * workspace created a moment later (a fresh worktree is exactly that case).
 */
const realCwdCache = new Map<string, string>()

function realCwd(cwd: string): string {
  const cached = realCwdCache.get(cwd)
  if (cached !== undefined) return cached
  try {
    const real = realpathSync.native(cwd)
    realCwdCache.set(cwd, real)
    return real
  } catch {
    // Path may not exist yet (or any more); fall back to the given path.
    return cwd
  }
}

/** Test seam: forget memoized real paths. */
export function clearRealCwdCache(): void {
  realCwdCache.clear()
}

/** Session directory for a workspace. */
export function sessionDirForCwd(cwd: string): string {
  return join(piSessionsRoot(), sessionDirNameForCwd(realCwd(cwd)))
}

/**
 * The Claude Code CLI's config directory — a separate program's tree, not
 * part of pi's. `CLAUDE_CONFIG_DIR` is the CLI's own documented override and
 * relocates the whole directory, `projects/` included.
 */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

// The cwd mangling itself is shared with the renderer's debug block.
export { claudeProjectDirName } from '@shared/claude-paths'

/** Root holding one subdirectory of CLI transcripts per project cwd. */
export function claudeProjectsRoot(): string {
  return join(claudeConfigDir(), 'projects')
}

/** The CLI's directory of transcripts for one workspace. */
export function claudeProjectDirForCwd(cwd: string): string {
  return join(claudeProjectsRoot(), claudeProjectDirName(realCwd(cwd)))
}

/**
 * The CLI's parallel copy of one session's transcript. pi passes its own
 * session id through to the CLI, so the two ledgers share an id and differ
 * only in where they live.
 *
 * This is a derived path, not a discovered one: the caller must treat a
 * missing file as normal.
 */
export function claudeSessionFileForCwd(cwd: string, sessionId: string): string {
  return join(claudeProjectDirForCwd(cwd), `${sessionId}.jsonl`)
}
