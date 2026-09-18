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
 * The message estimate mirrors pi's own `estimateTokens` (compaction.ts):
 * the same roles, the same block types, the same 4 chars per token and the
 * same 4,800-character stand-in for an image. And it walks the entries pi
 * actually sends, `buildContextEntries()`, never the whole branch: after a
 * compaction the branch still holds every summarized message, and measuring
 * it read 292k for a session whose context was 151k. The renderer then had
 * to scale that overshoot away and crushed the fixed parts with it.
 */

interface PiExtensionApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  getActiveTools?(): unknown
  getAllTools?(): unknown
  events?: { on(event: string, handler: (payload: unknown) => void): void }
}

interface ToolLike {
  name?: string
  description?: string
  parameters?: unknown
}

interface ExtensionContext {
  ui?: { setStatus?(key: string, text: string | undefined): void }
  getSystemPrompt?(): string | undefined
  getContextUsage?(): { tokens?: number; contextWindow?: number } | undefined
  sessionManager?: { getBranch?(): unknown[]; buildContextEntries?(): unknown[] }
}

/** The subset of pi's `SessionEntry` union this file reads. */
export interface SessionEntryLike {
  id?: string
  type?: string
  message?: {
    role?: string
    content?: unknown
    command?: string
    output?: string
  }
  summary?: string
  firstKeptEntryId?: string
  content?: unknown
}

export interface McpServerCost {
  /** Approximate tokens this server's schemas occupy in the window. */
  tokens: number
  /** Schemas in the window, gateway proxy included. */
  count: number
  /** Of those, the server's own tools (registered directly, not the proxy). */
  direct: number
  /** Tools the server offers, per the adapter; null when it has not said. */
  toolCount: number | null
}

export interface ContextBreakdown {
  /** pi's authoritative current context size, when it has one. */
  totalTokens: number | null
  contextWindow: number | null
  /** Approximate component sizes, in tokens. */
  parts: {
    messages: number
    systemPrompt: number
    tools: number
    mcpTools: number
  }
  /** `messages` is what is IN CONTEXT: entries since the last compaction. */
  counts: { tools: number; mcpTools: number; messages: number }
  /** Approximate MCP schema cost per server — which connector costs what. */
  mcpByServer: Record<string, McpServerCost>
  /** Always true — see the file header. Consumers must say so. */
  approximate: true
}

const STATUS_KEY = 'phosphor-context-breakdown'
/** The MCP adapter's status event, its only announcement of server names. */
const MCP_STATUS_EVENT = 'pi-mcp-adapter/status/v1'
/** pi's `ESTIMATED_IMAGE_CHARS` (compaction.ts). */
const ESTIMATED_IMAGE_CHARS = 4800
/**
 * The Claude Code provider's compaction marker (provider >= 0.8.3), appended
 * as a text block to the assistant message that was streaming when the CLI
 * cut its own context. pi's record never compacts on those sessions, so this
 * block is the only place the cut is visible from inside pi.
 */
const CLAUDE_COMPACT_MARKER = '[Claude Code · compact '

/** The adapter's own prefix sanitizer (`types.ts: sanitizeServerPrefix`). */
function sanitizeServerPrefix(serverName: string): string {
  return Array.from(serverName, (char) =>
    /^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`,
  ).join('')
}

/** The gateway's one-per-server proxy tool (`namespace-tools.ts`). */
export function isNamespaceProxy(toolName: string, server: string): boolean {
  return toolName === `mcp__${server.replace(/-/g, '_')}`
}

/**
 * Which MCP server a tool name belongs to, or null for one of pi's own tools.
 *
 * The adapter renames every MCP tool, and *how* depends on its `toolPrefix`
 * setting: `server` (the default) gives `<server>_<tool>`, `mcp` gives
 * `mcp__<server>_<tool>`, `short` strips a trailing `-mcp`, `none` does not
 * rename at all. Proxy-only servers instead get one namespace tool named
 * `mcp__<server>`. Matching only `mcp__` — which this file used to do — missed
 * the default, so a connector's schemas were billed to pi's built-in tools.
 *
 * `none` is genuinely unattributable from the name alone, and is reported as
 * built-in rather than guessed at.
 */
export function classifyToolServer(toolName: string, serverNames: string[]): string | null {
  // Longest server name first: `linear` must not claim `linear-readonly_*`.
  const candidates = [...serverNames].sort((a, b) => b.length - a.length)
  for (const server of candidates) {
    const sanitized = sanitizeServerPrefix(server)
    const namespaced = `mcp__${server.replace(/-/g, '_')}`
    const short = sanitizeServerPrefix(server.replace(/-?mcp$/i, '')) || 'mcp'
    if (
      toolName === namespaced ||
      toolName.startsWith(`${namespaced}_`) ||
      toolName.startsWith(`mcp__${sanitized}_`) ||
      toolName.startsWith(`${sanitized}_`) ||
      toolName.startsWith(`${short}_`)
    ) {
      return server
    }
  }
  // A server Phosphor has not been told about yet still reads as MCP when the
  // adapter namespaced it.
  const unknown = /^mcp__([A-Za-z0-9_]+?)(?:_|$)/.exec(toolName)
  return unknown?.[1] ?? null
}

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

/** pi's `estimateTextAndImageContentChars`. */
function textAndImageChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') chars += b.text.length
    else if (b.type === 'image') chars += ESTIMATED_IMAGE_CHARS
  }
  return chars
}

/** pi's `estimateTokens` for an assistant message, over a slice of its blocks. */
function assistantBlocksChars(blocks: unknown[]): number {
  let chars = 0
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const b = block as {
      type?: string
      text?: string
      thinking?: string
      name?: string
      arguments?: unknown
    }
    if (b.type === 'text' && typeof b.text === 'string') chars += b.text.length
    else if (b.type === 'thinking' && typeof b.thinking === 'string') chars += b.thinking.length
    else if (b.type === 'toolCall') {
      chars += (b.name ?? '').length
      try {
        chars += JSON.stringify(b.arguments ?? {}).length
      } catch {
        /* unserializable arguments still cost something; name counted */
      }
    }
  }
  return chars
}

/** Characters pi would count for one context entry (`estimateTokens` per role). */
export function entryChars(entry: SessionEntryLike): number {
  switch (entry.type) {
    case 'compaction':
    case 'branch_summary':
      return entry.summary?.length ?? 0
    case 'custom_message':
      return textAndImageChars(entry.content)
    case 'message': {
      const message = entry.message
      if (!message) return 0
      switch (message.role) {
        case 'assistant':
          return assistantBlocksChars(Array.isArray(message.content) ? message.content : [])
        case 'bashExecution':
          return (message.command ?? '').length + (message.output ?? '').length
        default:
          return textAndImageChars(message.content)
      }
    }
    default:
      return 0
  }
}

function isClaudeCompactBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const b = block as { type?: string; text?: string }
  return b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(CLAUDE_COMPACT_MARKER)
}

/**
 * Tokens and count of the messages the model currently holds.
 *
 * `entries` is pi's own context list, so a pi compaction is already applied.
 * A Claude Code session compacts inside the CLI instead, which pi's record
 * never reflects: its marker block is the cut point, and only what follows it
 * is still in the model's window (the CLI's summary is not visible here and
 * lands in the renderer's Unmeasured slice).
 */
export function measureMessages(entries: SessionEntryLike[]): { tokens: number; count: number } {
  let start = 0
  let startBlock = -1
  for (let i = entries.length - 1; i >= 0 && startBlock < 0; i--) {
    const entry = entries[i]!
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue
    const blocks = Array.isArray(entry.message.content) ? entry.message.content : []
    for (let j = blocks.length - 1; j >= 0; j--) {
      if (isClaudeCompactBlock(blocks[j])) {
        start = i
        startBlock = j
        break
      }
    }
  }

  let chars = 0
  let count = 0
  for (let i = start; i < entries.length; i++) {
    const entry = entries[i]!
    if (i === start && startBlock >= 0) {
      const blocks = entry.message?.content
      chars += assistantBlocksChars(Array.isArray(blocks) ? blocks.slice(startBlock + 1) : [])
      count++
      continue
    }
    if (entry.type === 'message') count++
    chars += entryChars(entry)
  }
  return { tokens: Math.ceil(chars / 4), count }
}

export default function contextBreakdownExtension(pi: PiExtensionApi): void {
  // Server names and tool totals come from the MCP adapter's status snapshots
  // on pi's shared event bus. Absent (no adapter, or an older one),
  // classification falls back to the `mcp__` namespace form and the chips
  // cannot say how many tools a server offers.
  const mcpServers = new Map<string, { toolCount: number | null }>()
  pi.events?.on(MCP_STATUS_EVENT, (payload) => {
    if (!payload || typeof payload !== 'object') return
    const servers = (payload as { servers?: unknown }).servers
    if (!Array.isArray(servers)) return
    mcpServers.clear()
    for (const entry of servers) {
      const record = entry as { name?: unknown; toolCount?: unknown } | null
      if (typeof record?.name !== 'string' || record.name.length === 0) continue
      const toolCount = record.toolCount
      mcpServers.set(record.name, {
        toolCount: typeof toolCount === 'number' && toolCount >= 0 ? toolCount : null,
      })
    }
  })

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
    const rawAll = pi.getAllTools?.() ?? []
    const allTools: ToolLike[] = Array.isArray(rawAll) ? (rawAll as ToolLike[]) : []

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

    const serverNames = [...mcpServers.keys()]
    let toolTokens = 0
    let mcpToolTokens = 0
    let mcpCount = 0
    const mcpByServer: Record<string, McpServerCost> = {}
    for (const tool of tools) {
      const size = sizeOfTool(tool)
      const name = typeof tool.name === 'string' ? tool.name : ''
      const server = name ? classifyToolServer(name, serverNames) : null
      if (server) {
        mcpToolTokens += size
        mcpCount++
        const bucket = (mcpByServer[server] ??= {
          tokens: 0,
          count: 0,
          direct: 0,
          toolCount: mcpServers.get(server)?.toolCount ?? null,
        })
        bucket.tokens += size
        bucket.count++
        if (!isNamespaceProxy(name, server)) bucket.direct++
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

    const breakdown: ContextBreakdown = {
      totalTokens: typeof usage?.tokens === 'number' ? usage.tokens : null,
      contextWindow: typeof usage?.contextWindow === 'number' ? usage.contextWindow : null,
      parts: {
        messages: messages.tokens,
        systemPrompt: estimateTokens(systemPrompt),
        tools: toolTokens,
        mcpTools: mcpToolTokens,
      },
      counts: { tools: tools.length - mcpCount, mcpTools: mcpCount, messages: messages.count },
      mcpByServer,
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
  pi.on('session_start', (_event, ctx) => publish(ctx as ExtensionContext))
  pi.on('agent_settled', (_event, ctx) => publish(ctx as ExtensionContext))
  pi.on('turn_end', (_event, ctx) => publish(ctx as ExtensionContext))
}
