/**
 * Phosphor worktree-paths extension — loaded into every Phosphor session via
 * `pi --mode rpc -e <this file>`, alongside artifacts.ts and
 * context-breakdown.ts.
 *
 * The failure it exists to stop: a session running in a linked git worktree
 * reads a file out of the MAIN checkout instead of its own tree, and nothing
 * says so. The two are different branches, so the model reviews code that is
 * not the code it was asked about — silently, and confidently.
 *
 * How it happens (reproduced against session 01a02ca0, pi 0.84.2 on the
 * Claude Code CLI provider): pi's tools accept relative paths, but Claude
 * Code's tool discipline pushes the model to absolutise them, and it builds
 * the absolute path from what it believes the project root is rather than
 * from the cwd it was given. Phosphor's worktrees live at
 * `<repo>/.phosphor/worktrees/<name>`, so the cwd literally contains the main
 * checkout as a prefix — trimming the `.phosphor/worktrees/<name>` segment
 * yields a path that exists, opens, and returns another branch's code. In
 * that session one of two reads leaked exactly this way, with the model's
 * own reasoning naming the correct RELATIVE path first.
 *
 * So the guard is narrow by construction. It fires only when all of these
 * hold, which no legitimate read satisfies by accident:
 *   1. the session cwd is a linked worktree (there is a main checkout), and
 *   2. the requested path resolves outside the cwd, and
 *   3. it resolves inside that main checkout, and
 *   4. the same repo-relative path exists inside the cwd.
 * Reading pi's own docs, ~/.pi, /tmp, or a main-checkout file with no
 * counterpart in the worktree is untouched.
 *
 * What it cannot see: on the Claude Code provider only pi's own tools reach
 * this hook (the CLI's control protocol denies `mcp__custom-tools__*` so pi
 * executes them) — Claude Code's internal tools are allowed to run inside the
 * CLI and never touch pi's tool layer. Both observed sessions read through
 * pi's `read`; the prompt block in `electron/pi/workspace-prompt.ts` is the
 * only cover for the other path.
 *
 * It blocks rather than rewrites: a silent correction trades one invisible
 * behaviour for another, and the model's next move (re-read at the right
 * path) is cheap. Asking for the identical path a second time is honoured —
 * that is the escape hatch for genuinely wanting the main checkout's copy,
 * e.g. "diff my version against main".
 *
 * Imports resolve against pi's own runtime when it loads the extension.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Loose structural types: the real ones live in @earendil-works/pi-coding-agent,
// which is provided by pi at load time (not a Phosphor dependency).
interface PiExtensionApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
}

interface ToolCallEvent {
  toolName?: string
  input?: { path?: unknown }
}

interface ExtensionContext {
  cwd?: string
}

/** Built-in pi tools whose `path` argument names a file or directory. */
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'find'])

/** `parent` contains `child` (or is it). Both must be absolute. */
function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * The in-worktree file the model probably meant, or null when the request is
 * none of this extension's business.
 *
 * Pure and injectable so the rule can be tested without a git repo on disk;
 * the extension supplies `existsSync`.
 */
export function worktreeCounterpart(input: {
  /** The session's working directory (the worktree). */
  cwd: string
  /** Main checkout of the same repo, or null when cwd is not a worktree. */
  mainRepoPath: string | null
  /** Path exactly as the model asked for it. */
  requestedPath: string
  exists: (path: string) => boolean
}): string | null {
  const { cwd, mainRepoPath, requestedPath } = input
  if (!mainRepoPath || !requestedPath) return null

  // Relative paths are already resolved against the cwd by pi, which is the
  // behaviour we want — there is nothing to correct.
  if (!isAbsolute(requestedPath)) return null

  const requested = resolve(cwd, requestedPath)
  // Checked before the main-checkout test on purpose: a nested worktree is
  // itself inside the main checkout, and its own files must stay allowed.
  if (contains(cwd, requested)) return null
  if (!contains(mainRepoPath, requested)) return null

  const candidate = join(cwd, relative(mainRepoPath, requested))
  if (candidate === requested) return null
  return input.exists(candidate) ? candidate : null
}

/**
 * Main checkout for `cwd`, or null when `cwd` is not a linked worktree.
 *
 * Same one-call detection as the app's own `git-info.ts`: in a linked
 * worktree the git dir is `<main>/.git/worktrees/<name>` while the common dir
 * is `<main>/.git`; in an ordinary repo the two are equal.
 */
function detectMainRepo(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const [gitDir, commonDirRaw] = out.split('\n').map((line) => line.trim())
    if (!gitDir || !commonDirRaw) return null
    // --git-common-dir comes back relative (".git") at a repo root.
    const commonDir = resolve(cwd, commonDirRaw)
    if (gitDir === commonDir) return null
    return dirname(commonDir)
  } catch {
    // Not a repo, or no git on PATH: nothing to guard against.
    return null
  }
}

export interface ToolCallBlock {
  block: true
  reason: string
}

/**
 * The `tool_call` handler, with its two effects injected so the rule can be
 * exercised without a git repo on disk. Exported for tests.
 */
export function createToolCallGuard(deps: {
  detectMainRepo: (cwd: string) => string | null
  exists: (path: string) => boolean
}): (rawEvent: unknown, rawCtx: unknown) => ToolCallBlock | undefined {
  /** Resolved once per cwd; a session does not move between trees. */
  const mainRepoByCwd = new Map<string, string | null>()
  /** Paths already refused once — asking again means the model meant it. */
  const allowedOnRetry = new Set<string>()

  return (rawEvent, rawCtx) => {
    const event = rawEvent as ToolCallEvent
    const ctx = rawCtx as ExtensionContext
    const cwd = ctx?.cwd
    if (!cwd || !event?.toolName || !PATH_TOOLS.has(event.toolName)) return
    const requestedPath = event.input?.path
    if (typeof requestedPath !== 'string') return

    if (!mainRepoByCwd.has(cwd)) mainRepoByCwd.set(cwd, deps.detectMainRepo(cwd))
    const mainRepoPath = mainRepoByCwd.get(cwd) ?? null

    const counterpart = worktreeCounterpart({
      cwd,
      mainRepoPath,
      requestedPath,
      exists: deps.exists,
    })
    if (!counterpart) return

    const requested = resolve(cwd, requestedPath)
    if (allowedOnRetry.has(requested)) return
    allowedOnRetry.add(requested)

    return {
      block: true,
      reason:
        `${requested} is in the repository's MAIN checkout, not in this session's ` +
        `working directory. This session runs in the git worktree ${cwd}, which is on a ` +
        `different branch — the main checkout's copy of this file is other-branch code and ` +
        `reading it will silently give you the wrong answer. Use ${counterpart} instead ` +
        `(and resolve relative paths against ${cwd}). If you really did mean the main ` +
        `checkout, request the same path again and it will be allowed.`,
    }
  }
}

export default function worktreePathsExtension(pi: PiExtensionApi): void {
  pi.on('tool_call', createToolCallGuard({ detectMainRepo, exists: existsSync }))
}
