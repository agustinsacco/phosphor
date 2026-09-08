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
  sessionManager?: { getBranch?(): unknown[] }
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
  counts: { tools: number; mcpTools: number; messages: number }
  /** Approximate MCP schema cost per server — which connector costs what. */
  mcpByServer: Record<string, { tokens: number; count: number }>
  /** Always true — see the file header. Consumers must say so. */
  approximate: true
}

const STATUS_KEY = 'phosphor-context-breakdown'
/** The MCP adapter's status event, its only announcement of server names. */
const MCP_STATUS_EVENT = 'pi-mcp-adapter/status/v1'

/** The adapter's own prefix sanitizer (`types.ts: sanitizeServerPrefix`). */
function sanitizeServerPrefix(serverName: string): string {
  return Array.from(serverName, (char) =>
    /^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`,
  ).join('')
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

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (typeof b.text === 'string') out += b.text
    if (typeof b.thinking === 'string') out += b.thinking
    if (b.arguments !== undefined) {
      try {
        out += JSON.stringify(b.arguments)
      } catch {
        /* ignore */
      }
    }
    // Images contribute real tokens but are not measurable here; they are
    // deliberately excluded rather than guessed at.
  }
  return out
}

export default function contextBreakdownExtension(pi: PiExtensionApi): void {
  // Server names come from the MCP adapter's status snapshots on pi's shared
  // event bus. Absent (no adapter, or an older one), classification falls back
  // to the `mcp__` namespace form.
  let mcpServerNames: string[] = []
  pi.events?.on(MCP_STATUS_EVENT, (payload) => {
    if (!payload || typeof payload !== 'object') return
    const servers = (payload as { servers?: unknown }).servers
    if (!Array.isArray(servers)) return
    mcpServerNames = servers
      .map((entry) => (entry as { name?: unknown })?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
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

    let toolTokens = 0
    let mcpToolTokens = 0
    let mcpCount = 0
    const mcpByServer: Record<string, { tokens: number; count: number }> = {}
    for (const tool of tools) {
      const size = sizeOfTool(tool)
      const server =
        typeof tool.name === 'string' ? classifyToolServer(tool.name, mcpServerNames) : null
      if (server) {
        mcpToolTokens += size
        mcpCount++
        const bucket = (mcpByServer[server] ??= { tokens: 0, count: 0 })
        bucket.tokens += size
        bucket.count++
      } else {
        toolTokens += size
      }
    }

    let messageTokens = 0
    let messageCount = 0
    const entries = ctx.sessionManager?.getBranch?.() ?? []
    for (const entry of entries) {
      const record = entry as { type?: string; message?: { content?: unknown } }
      if (record.type !== 'message' || !record.message) continue
      messageCount++
      messageTokens += estimateTokens(contentToText(record.message.content))
    }

    const breakdown: ContextBreakdown = {
      totalTokens: typeof usage?.tokens === 'number' ? usage.tokens : null,
      contextWindow: typeof usage?.contextWindow === 'number' ? usage.contextWindow : null,
      parts: {
        messages: messageTokens,
        systemPrompt: estimateTokens(systemPrompt),
        tools: toolTokens,
        mcpTools: mcpToolTokens,
      },
      counts: { tools: tools.length - mcpCount, mcpTools: mcpCount, messages: messageCount },
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
