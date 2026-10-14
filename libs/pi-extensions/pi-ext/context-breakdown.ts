/**
 * Phosphor context-breakdown extension — loaded into every Phosphor session via
 * `pi --mode rpc -e <this file>`, alongside artifacts.ts.
 *
 * pi reports context usage as a single number (`contextUsage.tokens`), which
 * answers "how full" but never "full of what". The parts are only visible
 * from inside pi — the composed system prompt, the active tool schemas — so
 * this extension measures them and pushes a breakdown to the front-end
 * through `ctx.ui.setStatus`, which Phosphor already routes per session.
 *
 * Provider-agnostic on purpose: it reads pi's own state, so it works
 * identically for local models, native Anthropic, and the Claude Code CLI
 * provider.
 *
 * Estimates, honestly labelled: only the TOTAL comes from pi. Component
 * sizes are character-based approximations (no tokenizer is available to
 * extensions), so the UI presents them as approximate and always shows
 * pi's authoritative total alongside.
 *
 * Messages are the exception: `message-ledger.ts` measures them from pi's
 * own per-request usage where it can, which also finds the reasoning a reply
 * holds beyond its visible summary (`thinking`). It walks the entries pi
 * actually sends, `buildContextEntries()`, never the whole branch: after a
 * compaction the branch still holds every summarized message, and measuring
 * it read 292k for a session whose context was 151k. The renderer then had
 * to scale that overshoot away and crushed the fixed parts with it.
 */

import contextBudget, { type BudgetApi } from './context-budget'
import swarm from './swarm'
import contextFiles, { contextFilesIn, type ContextFileInfo } from './context-files'
import { measureMessages, type LedgerEntry } from './message-ledger'

export { entryChars, measureMessages } from './message-ledger'

interface PiExtensionApi extends BudgetApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  getActiveTools?(): unknown
  getAllTools?(): unknown
}

interface ToolLike {
  name?: string
  description?: string
  parameters?: unknown
  /** pi's tool group; an MCP server's tools carry `mcp__<server>`, aliased by the server's name. */
  namespace?: { name?: string; aliases?: unknown }
}

interface ExtensionContext {
  ui?: { setStatus?(key: string, text: string | undefined): void }
  getSystemPrompt?(): string | undefined
  getContextUsage?(): { tokens?: number; contextWindow?: number } | undefined
  sessionManager?: { getBranch?(): unknown[]; buildContextEntries?(): unknown[] }
}

/** The subset of pi's `SessionEntry` union this file reads. */
export interface SessionEntryLike extends LedgerEntry {
  id?: string
  firstKeptEntryId?: string
}

export interface McpServerCost {
  /** Approximate tokens this server's schemas occupy in the window. */
  tokens: number
  /** The server's tools with a schema in the window (`direct`, or loaded by tool search). */
  count: number
  /** Tools the server offers: every one pi registered for it. */
  toolCount: number
}

export interface ContextBreakdown {
  /** pi's authoritative current context size, when it has one. */
  totalTokens: number | null
  contextWindow: number | null
  /** Approximate component sizes, in tokens. */
  parts: {
    messages: number
    /** Reasoning held in the window, measured from usage (message-ledger.ts). */
    thinking: number
    systemPrompt: number
    tools: number
    mcpTools: number
  }
  /** `messages` is what is IN CONTEXT: entries since the last compaction. */
  counts: { tools: number; mcpTools: number; messages: number }
  /** Approximate MCP schema cost per server — which connector costs what. */
  mcpByServer: Record<string, McpServerCost>
  /** CLAUDE.md / AGENTS.md this lane found, and which it leaves out (context-files.ts). */
  contextFiles: { off: string[]; files: ContextFileInfo[] }
  /** Always true — see the file header. Consumers must say so. */
  approximate: true
}

const STATUS_KEY = 'phosphor-context-breakdown'

/**
 * The MCP server a tool belongs to, or null for any other tool.
 *
 * pi groups a server's tools under the namespace `mcp__<server>` and aliases
 * it with the server's configured name, which keeps a `-` the namespace turns
 * into `_`. The name prefix is the fallback for a tool without a namespace.
 */
export function mcpServerOf(tool: ToolLike): string | null {
  const namespace = tool.namespace
  if (typeof namespace?.name === 'string' && namespace.name.startsWith('mcp__')) {
    const alias = Array.isArray(namespace.aliases) ? namespace.aliases[0] : undefined
    return typeof alias === 'string' && alias ? alias : namespace.name.slice('mcp__'.length)
  }
  const name = typeof tool.name === 'string' ? tool.name : ''
  return /^mcp__(.+?)__./.exec(name)?.[1] ?? null
}

/** Which MCP tools pi has registered: changes as servers connect. */
function mcpSignature(tools: ToolLike[]): string {
  return tools
    .filter((tool) => mcpServerOf(tool) !== null)
    .map((tool) => tool.name)
    .join(',')
}

/** How long after a session starts its servers may still be connecting. */
const CONNECT_WATCH_MS = 60_000

/**
 * ~4 characters per token. Crude, but the only option available in-process,
 * and consistent across components so the *proportions* stay meaningful even
 * where the absolute numbers drift.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function sizeOfTool(tool: ToolLike): number {
  let text = `${tool.name ?? ''}${tool.description ?? ''}`
  try {
    text += JSON.stringify(tool.parameters ?? {})
  } catch {
    // Unserializable schema — name + description is still a signal.
  }
  return estimateTokens(text)
}

/**
 * pi's `buildContextEntries`, over a branch: the last compaction entry, then
 * the kept tail from `firstKeptEntryId` up to it, then everything after it.
 * Used only when the session manager does not expose its own.
 */
export function contextEntriesOf(branch: SessionEntryLike[]): SessionEntryLike[] {
  let compactionIdx = -1
  branch.forEach((entry, index) => {
    if (entry.type === 'compaction') compactionIdx = index
  })
  if (compactionIdx < 0) return branch
  const compaction = branch[compactionIdx]!
  const kept: SessionEntryLike[] = [compaction]
  let foundFirstKept = false
  for (let i = 0; i < compactionIdx; i++) {
    const entry = branch[i]!
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true
    if (foundFirstKept) kept.push(entry)
  }
  kept.push(...branch.slice(compactionIdx + 1))
  return kept
}

export default function contextBreakdownExtension(pi: PiExtensionApi): void {
  contextBudget(pi)
  // A toggle runs no turn, so publish from the command itself.
  const files = contextFiles(pi, (ctx) => {
    latestContext = ctx as ExtensionContext
    publish(latestContext)
  })
  const swarmPolicy = swarm(pi, (ctx) => publish(ctx as ExtensionContext))
  // The last lifecycle context, for a publish no event triggers: an MCP server
  // that finishes connecting after `session_start` (see `watchConnections`).
  // Session replacement fires a fresh `session_start`, which replaces it.
  let latestContext: ExtensionContext | undefined
  let publishedMcp = ''

  function publish(ctx: ExtensionContext): void {
    const setStatus = ctx.ui?.setStatus
    if (typeof setStatus !== 'function') return

    const usage = ctx.getContextUsage?.()
    const systemPrompt = ctx.getSystemPrompt?.() ?? ''

    // getAllTools() yields definitions (name + description + schema);
    // getActiveTools() yields the ACTIVE NAMES. Only the definitions carry
    // the schema that actually occupies context, so sizes come from
    // getAllTools and the active list is used purely as a filter — measuring
    // the name list instead reports a handful of tokens for a tool set that
    // really costs thousands.
    const allTools = registeredTools()
    publishedMcp = mcpSignature(allTools)

    const rawActive = pi.getActiveTools?.() ?? []
    const activeNames = new Set<string>(
      (Array.isArray(rawActive) ? rawActive : [])
        .map((entry) => (typeof entry === 'string' ? entry : ((entry as ToolLike)?.name ?? '')))
        .filter((name) => name.length > 0),
    )

    const tools =
      activeNames.size > 0
        ? allTools.filter((tool) => typeof tool.name === 'string' && activeNames.has(tool.name))
        : allTools

    let toolTokens = 0
    let mcpToolTokens = 0
    let mcpCount = 0
    const mcpByServer: Record<string, McpServerCost> = {}
    for (const tool of allTools) {
      const server = mcpServerOf(tool)
      if (server) (mcpByServer[server] ??= { tokens: 0, count: 0, toolCount: 0 }).toolCount++
    }
    for (const tool of tools) {
      const size = sizeOfTool(tool)
      const server = mcpServerOf(tool)
      if (server) {
        mcpToolTokens += size
        mcpCount++
        const bucket = (mcpByServer[server] ??= { tokens: 0, count: 0, toolCount: 0 })
        bucket.tokens += size
        bucket.count++
      } else {
        toolTokens += size
      }
    }

    const manager = ctx.sessionManager
    const rawEntries =
      typeof manager?.buildContextEntries === 'function'
        ? manager.buildContextEntries()
        : contextEntriesOf((manager?.getBranch?.() ?? []) as SessionEntryLike[])
    const messages = measureMessages(rawEntries as SessionEntryLike[])
    // pi's prompt still holds a file the lane leaves out; the model is not sent it.
    const off = files.off()
    const foundFiles = contextFilesIn(systemPrompt, off)
    const omitted = foundFiles
      .filter((file) => !file.included)
      .reduce((sum, file) => sum + file.tokens, 0)

    const breakdown: ContextBreakdown = {
      totalTokens: typeof usage?.tokens === 'number' ? usage.tokens : null,
      contextWindow: typeof usage?.contextWindow === 'number' ? usage.contextWindow : null,
      parts: {
        messages: messages.tokens,
        thinking: messages.thinking,
        systemPrompt: Math.max(0, estimateTokens(systemPrompt) - omitted) + swarmPolicy.tokens(),
        tools: toolTokens,
        mcpTools: mcpToolTokens,
      },
      counts: { tools: tools.length - mcpCount, mcpTools: mcpCount, messages: messages.count },
      mcpByServer,
      contextFiles: { off: [...off], files: foundFiles },
      approximate: true,
    }

    try {
      setStatus.call(ctx.ui, STATUS_KEY, JSON.stringify(breakdown))
    } catch {
      // A status push must never break a turn.
    }
  }

  // Publish at rest, not mid-stream: the numbers only change meaningfully
  // between turns, and a per-delta recompute would walk the whole branch on
  // every token.
  const remember = (_event: unknown, ctx: unknown): void => {
    latestContext = ctx as ExtensionContext
    publish(latestContext)
  }
  function registeredTools(): ToolLike[] {
    const raw = pi.getAllTools?.() ?? []
    return Array.isArray(raw) ? (raw as ToolLike[]) : []
  }

  // pi connects MCP servers after `session_start` and registers their tools
  // as each one answers, with no event for it. So for a while after a start,
  // look for new MCP tools once a second and re-measure only when they
  // changed: the publish itself walks the whole branch.
  let watch: ReturnType<typeof setInterval> | undefined
  function watchConnections(): void {
    clearInterval(watch)
    const until = Date.now() + CONNECT_WATCH_MS
    watch = setInterval(() => {
      if (Date.now() > until) clearInterval(watch)
      if (!latestContext || mcpSignature(registeredTools()) === publishedMcp) return
      try {
        publish(latestContext)
      } catch {
        // A context from a replaced session; the next lifecycle event brings a fresh one.
      }
    }, 1000)
    watch.unref?.()
  }

  pi.on('session_start', (event, ctx) => {
    remember(event, ctx)
    watchConnections()
  })
  pi.on('session_shutdown', () => clearInterval(watch))
  pi.on('model_select', remember)
  pi.on('agent_settled', remember)
  pi.on('turn_end', remember)
}
