import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { claudeProjectDirName } from '@shared/claude-paths'
import type { AgentKind } from '@shared/models'
import { activeAgent } from './agent'

/**
 * Single source of truth for pi's on-disk layout. Both the agent-settings
 * reader and the session scanner depend on the same env-var contract, so it
 * lives in one place rather than being restated per consumer.
 *
 * Layout (verified against the local install):
 *   ~/.pi/agent/sessions/--<cwd segments joined by dashes>--/<ts>_<uuid>.jsonl
 *
 * omp's session layout lives here too, because the sidebar reads whichever
 * agent sessions run on (Settings → Advanced → Agent):
 *   ~/.omp/agent/sessions/-<home-relative cwd, dashed>/<ts>_<uuid>.jsonl
 * See `ompSessionDirNameForCwd` for the three shapes that name takes.
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
 * omp's agent directory. Mirrors omp's `getAgentDir` (`pi-utils/src/dirs.ts`,
 * 18.4.2) for its default profile: `PI_CODING_AGENT_DIR` — the same variable
 * pi reads, so setting it moves both — else `~/<PI_CONFIG_DIR or .omp>/agent`.
 * Named profiles (`--profile`, `OMP_PROFILE`) and Linux XDG relocation are not
 * followed; point `PI_CODING_AGENT_DIR` at such a directory instead.
 */
export function ompAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), process.env.PI_CONFIG_DIR || '.omp', 'agent')
  )
}

/** omp's root holding one subdirectory of session files per workspace. */
export function ompSessionsRoot(): string {
  return join(ompAgentDir(), 'sessions')
}

/** The sessions root of the agent sessions run on — or of `agent`, when named. */
export function agentSessionsRoot(agent: AgentKind = activeAgent().kind): string {
  return agent === 'omp' ? ompSessionsRoot() : piSessionsRoot()
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

/**
 * omp's session directory name for an already-resolved cwd, transcribed from
 * `getDefaultSessionDirName` (`session/session-paths.ts`, omp 18.4.2). Three
 * shapes, by where the cwd sits:
 *
 *   under home    `~/projects/app` → `-projects-app`   (home itself → `-`)
 *   under tmpdir  `$TMPDIR/x/y`    → `-tmp-x-y`
 *   anywhere else `/srv/app`       → `--srv-app--`     (pi's own rule)
 *
 * omp resolves home and tmpdir through `realpath` as well as the cwd, so on
 * macOS `/var/folders/…/T` and `/private/var/folders/…/T` are the same tmpdir.
 * The roots are parameters only so tests can place them.
 */
export function ompSessionDirNameForCwd(
  cwd: string,
  home: string = realCwd(homedir()),
  temp: string = realCwd(tmpdir()),
): string {
  const under = (root: string): string | null => {
    const rel = relative(root, cwd)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? rel : null
  }
  const dashed = (rel: string): string => rel.replace(/[/\\:]/g, '-')
  const fromHome = under(home)
  if (fromHome !== null) return `-${dashed(fromHome)}`
  const fromTemp = under(temp)
  if (fromTemp !== null) return fromTemp ? `-tmp-${dashed(fromTemp)}` : '-tmp'
  return sessionDirNameForCwd(cwd)
}

/** Session directory for a workspace, in the layout of the agent sessions run on. */
export function sessionDirForCwd(cwd: string, agent: AgentKind = activeAgent().kind): string {
  const real = realCwd(cwd)
  return agent === 'omp'
    ? join(ompSessionsRoot(), ompSessionDirNameForCwd(real))
    : join(piSessionsRoot(), sessionDirNameForCwd(real))
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
