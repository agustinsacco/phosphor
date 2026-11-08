/**
 * Leaves a repository's CLAUDE.md and/or AGENTS.md out of what a lane's model
 * is sent.
 *
 * pi discovers these context files itself (agent dir, cwd and its parents) and
 * renders them into one `project_context` system-prompt section. A repo's
 * CLAUDE.md alone can be thousands of tokens on every request, so the composer
 * offers a per-lane opt-out. The user's global file in the agent directory is
 * not a repository file: it carries the instructions written in Settings, so
 * it is always sent (and kept current by global-context.ts).
 *
 * Request-local on purpose. The filter runs in `context_with_system`, which
 * fires before EVERY model request — including runs that start without a user
 * prompt (a sub-agent's completion wakes the parent with a custom message, and
 * pi rebuilds that run's prompt from its unfiltered base options). Filtering in
 * `before_agent_start` alone let a disabled file back in on those runs. The
 * transcript is left exactly as pi wrote it, so turning a file back on restores
 * it on the next request with no restart.
 *
 * Wire contract with Phosphor main (`libs/shared/src/context-files.ts`):
 * the starting state arrives in `PHOSPHOR_CONTEXT_FILES`, later changes as
 * `/phosphor-context-files`, both in the grammar `claude=off agents=on`.
 *
 * A change is also written to the session as a custom entry, and the newest
 * one on the branch wins over the environment at `session_start`. Without it
 * a reload (`lane-reload.ts`, which rebuilds every extension) or a lane
 * reopened later would fall back to the preference new lanes start with.
 *
 * A second rule needs no toggle. pi's parent-directory walk does not stop at
 * a worktree's root, and Phosphor's worktrees sit inside the checkout they
 * branch from, so a lane at `<repo>/.phosphor/worktrees/<name>` is also sent
 * the main checkout's CLAUDE.md / AGENTS.md: another branch's rules (a stale
 * layout, wrong paths) and, when the worktree has its own copy, the same text
 * twice. Measured at 2.6k tokens on every request of every Phosphor worktree
 * lane. In a linked worktree, any file pi found inside the main checkout and
 * outside the cwd is dropped, whatever the toggles say, and reported with
 * `excludedBy: 'main-checkout'` so the composer can show why. The detector is
 * the one `worktree-paths.ts` uses (`main-checkout.ts`).
 *
 * Self-contained because pi loads this file on its own, outside Phosphor's
 * module graph.
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { detectMainRepo, isMainCheckoutPath, type WorktreeInfo } from './main-checkout'

export type ContextFileKind = 'claude' | 'agents'

export const CONTEXT_FILES_ENV = 'PHOSPHOR_CONTEXT_FILES'
export const CONTEXT_FILES_COMMAND = 'phosphor-context-files'
/** The session entry a toggle leaves behind; `data` is `{ off: ContextFileKind[] }`. */
export const CONTEXT_FILES_ENTRY = 'phosphor-context-files'

/** Which toggle a discovered file belongs to, by its file name. */
export function contextFileKind(path: string): ContextFileKind | null {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (name === 'claude.md') return 'claude'
  if (name === 'agents.md' || name === 'agents.override.md') return 'agents'
  return null
}

/** Apply `claude=off agents=on` (space or comma separated). Throws on anything else. */
export function applyContextFileArgs(
  off: ReadonlySet<ContextFileKind>,
  args: string,
): Set<ContextFileKind> {
  const next = new Set(off)
  for (const token of args.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(claude|agents)=(on|off)$/.exec(token)
    if (!match) throw new Error(`Invalid context file setting: ${token}`)
    const kind = match[1] as ContextFileKind
    if (match[2] === 'off') next.add(kind)
    else next.delete(kind)
  }
  return next
}

/*
 * pi's rendering (system-prompt.ts, verified on 0.87.1): the section is
 * `<project_context>\n…\n</project_context>`, holding a header line and one
 * `<project_instructions path="…">\n<content>\n</project_instructions>` block
 * per file, joined by blank lines. A block boundary is the closing tag, a blank
 * line and an opening tag, so a file that merely mentions the tags does not
 * split itself.
 */
const OPEN = '<project_context>\n'
const CLOSE = '\n</project_context>'
const HEADER = 'Project-specific instructions and guidelines:'
const BOUNDARY = /(?<=\n<\/project_instructions>)\n\n(?=<project_instructions path="[^"\n]*">\n)/
const BLOCK_PATH = /^<project_instructions path="([^"\n]*)">\n/

/** pi's section around already rendered blocks. */
export function renderProjectContext(blocks: readonly string[]): string {
  return `${OPEN}${[HEADER, ...blocks].join('\n\n')}${CLOSE}`
}

/** pi's agent directory, resolved like pi: a custom, `~/` or relative path included. */
export function globalAgentDir(
  agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
): string {
  return resolve(agentDir.replace(/^~(?=$|[/\\])/, homedir()))
}

/** Whether a rendered block's file lives directly in the (resolved) agent directory. */
export const isGlobalContextPath = (path: string, agentDir: string): boolean =>
  dirname(resolve(path)) === agentDir

export interface ContextBlock {
  path: string
  /** The whole rendered block, tags included. */
  text: string
}

/** A rendered `project_context` section's blocks, or null when it is not pi's shape. */
export function parseProjectContext(section: string): ContextBlock[] | null {
  if (!section.startsWith(OPEN) || !section.endsWith(CLOSE)) return null
  const inner = section.slice(OPEN.length, -CLOSE.length)
  if (!inner.startsWith(`${HEADER}\n\n`)) return null
  const blocks: ContextBlock[] = []
  for (const text of inner.slice(HEADER.length + 2).split(BOUNDARY)) {
    const match = BLOCK_PATH.exec(text)
    if (!match) return null
    blocks.push({ path: match[1]!, text })
  }
  return blocks
}

/**
 * The section without the disabled repository files, nor the main checkout's
 * when the lane runs in a worktree: unchanged when nothing matches or the
 * shape is unknown, null when no file is left. The global file in `agentDir`
 * always stays.
 */
export function filterProjectContext(
  section: string,
  off: ReadonlySet<ContextFileKind>,
  agentDir = globalAgentDir(),
  worktree: WorktreeInfo | null = null,
): string | null {
  const blocks = parseProjectContext(section)
  if (!blocks) return section
  const kept = blocks.filter((block) => {
    if (isGlobalContextPath(block.path, agentDir)) return true
    if (isMainCheckoutPath(block.path, worktree)) return false
    const kind = contextFileKind(block.path)
    return !kind || !off.has(kind)
  })
  if (kept.length === blocks.length) return section
  if (kept.length === 0) return null
  return renderProjectContext(kept.map((block) => block.text))
}

/** The `project_context` section inside a fully rendered system prompt. */
export function projectContextOf(systemPrompt: string): string | null {
  const start = systemPrompt.indexOf(OPEN)
  if (start < 0) return null
  const end = systemPrompt.indexOf(CLOSE, start)
  return end < 0 ? null : systemPrompt.slice(start, end + CLOSE.length)
}

interface SystemMessageLike {
  role?: string
  sections?: Record<string, string | null>
}

/**
 * Strip disabled files from every system message, in place.
 *
 * The leading message declares sections and later ones patch them by name.
 * A leading section left empty is dropped; a later patch left empty becomes a
 * removal (`null`), because simply dropping the key would keep whatever an
 * earlier message declared.
 */
export function filterSystemMessages(
  messages: unknown[],
  off: ReadonlySet<ContextFileKind>,
  agentDir = globalAgentDir(),
  worktree: WorktreeInfo | null = null,
): boolean {
  let changed = false
  let leading = true
  for (const message of messages) {
    const m = message as SystemMessageLike | null
    if (m?.role !== 'system') continue
    const isLeading = leading
    leading = false
    const section = m.sections?.project_context
    if (typeof section !== 'string') continue
    const next = filterProjectContext(section, off, agentDir, worktree)
    if (next === section) continue
    changed = true
    if (next !== null) m.sections!.project_context = next
    else if (isLeading) delete m.sections!.project_context
    else m.sections!.project_context = null
  }
  return changed
}

export interface ContextFileInfo {
  path: string
  kind: ContextFileKind
  scope: 'global' | 'project'
  /** ~4 characters per token, like the rest of the breakdown. */
  tokens: number
  /** Always true for the global file: the toggles cover repository files only. */
  included: boolean
  /** Left out by location, not by a toggle: the main checkout's file in a worktree lane. */
  excludedBy?: 'main-checkout'
}

/** Context files in a rendered prompt, with what each costs and whether it is sent. */
export function contextFilesIn(
  systemPrompt: string,
  off: ReadonlySet<ContextFileKind>,
  agentDir?: string,
  worktree: WorktreeInfo | null = null,
): ContextFileInfo[] {
  // Match pi's agent-directory discovery, including custom and ~/ paths.
  // Everything else is inherited from cwd/ancestors, not user-global config.
  const globalDir = globalAgentDir(agentDir)
  const section = projectContextOf(systemPrompt)
  const blocks = section ? parseProjectContext(section) : null
  const files: ContextFileInfo[] = []
  for (const block of blocks ?? []) {
    const kind = contextFileKind(block.path)
    if (!kind) continue
    const scope = isGlobalContextPath(block.path, globalDir) ? 'global' : 'project'
    const mainCheckout = scope === 'project' && isMainCheckoutPath(block.path, worktree)
    files.push({
      path: block.path,
      kind,
      scope,
      tokens: Math.ceil(block.text.length / 4),
      included: scope === 'global' || (!off.has(kind) && !mainCheckout),
      ...(mainCheckout ? { excludedBy: 'main-checkout' as const } : {}),
    })
  }
  return files
}

/** The lane's last toggle on this branch, or null when it never toggled. */
export function savedContextFiles(branch: readonly unknown[]): Set<ContextFileKind> | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown } | null
    if (entry?.type !== 'custom' || entry.customType !== CONTEXT_FILES_ENTRY) continue
    const saved = (entry.data as { off?: unknown } | null)?.off
    if (!Array.isArray(saved)) return null
    return new Set(
      saved.filter((kind): kind is ContextFileKind => kind === 'claude' || kind === 'agents'),
    )
  }
  return null
}

interface ContextFilesApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  appendEntry?(customType: string, data: unknown): void
  registerCommand?(
    name: string,
    command: { description: string; handler(args: string, ctx: unknown): Promise<void> },
  ): void
}

/**
 * Holds the lane's setting; `onChange` lets the breakdown re-publish at once.
 * It starts from `env` and keeps it current, which is how sub-agents, started
 * later in this process or as its children, get the setting.
 * `detect` is the Git lookup for the worktree rule, injectable so tests never
 * spawn git; it runs once per cwd, and only when a context carries one.
 */
export default function contextFiles(
  pi: ContextFilesApi,
  onChange: (ctx: unknown) => void = () => undefined,
  env: NodeJS.ProcessEnv = process.env,
  agentDir: string = globalAgentDir(),
  detect: (cwd: string) => string | null = detectMainRepo,
): { off: () => ReadonlySet<ContextFileKind>; worktree: () => WorktreeInfo | null } {
  let off = new Set<ContextFileKind>()
  /** Resolved once per cwd; a session does not move between trees. */
  const mainRepoByCwd = new Map<string, string | null>()
  let worktree: WorktreeInfo | null = null
  const locate = (ctx: unknown): void => {
    const cwd = (ctx as { cwd?: unknown } | null | undefined)?.cwd
    if (typeof cwd !== 'string' || !cwd) return
    if (!mainRepoByCwd.has(cwd)) mainRepoByCwd.set(cwd, detect(cwd))
    const mainRepoPath = mainRepoByCwd.get(cwd) ?? null
    worktree = mainRepoPath ? { cwd, mainRepoPath } : null
  }
  try {
    off = applyContextFileArgs(off, env[CONTEXT_FILES_ENV] ?? '')
  } catch {
    // A malformed value from the environment sends every file, as pi would.
  }
  const share = (): void => {
    if (off.size > 0) env[CONTEXT_FILES_ENV] = [...off].map((kind) => `${kind}=off`).join(' ')
    else delete env[CONTEXT_FILES_ENV]
  }
  pi.registerCommand?.(CONTEXT_FILES_COMMAND, {
    description: 'Host control: include or leave out CLAUDE.md / AGENTS.md without running a model',
    async handler(args, ctx) {
      off = applyContextFileArgs(off, args)
      share()
      pi.appendEntry?.(CONTEXT_FILES_ENTRY, { off: [...off] })
      onChange(ctx)
    },
  })
  // Registered before the breakdown's own session_start handler, which
  // publishes what this restores.
  pi.on('session_start', (_event, ctx) => {
    locate(ctx)
    const manager = (ctx as { sessionManager?: { getBranch?: () => unknown[] } } | undefined)
      ?.sessionManager
    const saved = savedContextFiles(manager?.getBranch?.() ?? [])
    if (saved) {
      off = saved
      share()
    }
  })
  pi.on('context_with_system', (event, ctx) => {
    locate(ctx)
    if (off.size === 0 && !worktree) return undefined
    const messages = (event as { messages?: unknown[] }).messages
    if (!Array.isArray(messages) || !filterSystemMessages(messages, off, agentDir, worktree)) {
      return undefined
    }
    return { messages }
  })
  return { off: () => off, worktree: () => worktree }
}
