/**
 * Context-window composition, as reported by Phosphor's bundled
 * `pi-ext/context-breakdown.ts` extension over pi's status channel.
 *
 * pi's RPC reports one number for context usage — how full, never full of
 * what. The parts (composed system prompt, active tool schemas) are visible
 * only from inside pi, so the extension measures them there and pushes JSON
 * through `ctx.ui.setStatus`, which lands in the extension-UI store.
 *
 * Provider-agnostic: the extension loads into every session, so this works
 * for local models, native Anthropic and the Claude Code CLI provider alike.
 */

export const CONTEXT_BREAKDOWN_STATUS_KEY = 'phosphor-context-breakdown'

export interface McpServerCost {
  /** Approximate tokens this server's schemas occupy in the window. */
  tokens: number
  /** Schemas in the window, the gateway proxy included. */
  count: number
  /** Of those, the server's own tools registered directly (not the proxy). */
  direct: number
  /** Tools the server offers, per the adapter; null when unknown. */
  toolCount: number | null
}

export interface ContextBreakdown {
  totalTokens: number | null
  contextWindow: number | null
  parts: { messages: number; systemPrompt: number; tools: number; mcpTools: number }
  /** `messages` is what is in context: entries since the last compaction. */
  counts: { tools: number; mcpTools: number; messages: number }
  /** Approximate MCP schema cost per server. Absent from older payloads. */
  mcpByServer: Record<string, McpServerCost>
  approximate: boolean
}

/** One rendered row: a slice of the window with its share. */
export interface BreakdownSlice {
  key: string
  label: string
  tokens: number
  /** Share of the context window, 0–100. */
  percent: number
  /** CSS colour for the bar segment and dot. */
  color: string
  count?: number
  /** Explains a slice the labels alone cannot; rendered as the row's title. */
  hint?: string
}

/**
 * How much of pi's total the extension could not attribute.
 *
 * The extension measures pi's own state — its composed system prompt and its
 * active tool schemas. Under a CLI provider that is only part of the request:
 * the provider wraps pi's context in its own framing. Before pi-claude-cli
 * 0.9.0 the Claude Code CLI also sent its own system prompt and native tool
 * schemas, and kept native tool results in its own transcript. Measured live
 * on 2026-09-09, that unattributable share was ~29k tokens on turn 1 of a
 * Claude session and ~0.5k on a native one.
 *
 * It must be shown as its own slice, never spread across the measured ones.
 */
export function measuredTokens(breakdown: ContextBreakdown): number {
  const p = breakdown.parts
  return p.messages + p.systemPrompt + p.tools + p.mcpTools
}

/** The parts that do not change between turns: prompt and schemas. */
function fixedTokens(breakdown: ContextBreakdown): number {
  const p = breakdown.parts
  return p.systemPrompt + p.tools + p.mcpTools
}

/**
 * Estimates are fitted to pi's total, never inflated to it.
 *
 * Up is dishonest: it assumes every token pi counts belongs to something the
 * extension measured, which is false for any CLI provider, so the provider's
 * own prompt and tool schemas were silently added to *our* slices. A fixed
 * 9,914-token system prompt rendered as 44.1k then 22.5k across four turns of
 * one Claude session. The remainder is the `unmeasured` slice instead.
 *
 * Down is taken from the MESSAGES first, and from the fixed parts only as a
 * last resort. The prompt and the schemas are the same size on every turn and
 * the extension measures them exactly (the text is in hand); the message
 * estimate is the one that overshoots. Scaling all four
 * by one factor turned 4.6k of system prompt into 1.5k and 534 tokens of MCP
 * proxies into 237, and made seven identical proxy schemas read as "34" on
 * one session and "77" on the next.
 */
function fit(breakdown: ContextBreakdown, total: number): { messages: number; fixed: number } {
  const fixed = fixedTokens(breakdown)
  if (total <= 0) return { messages: 0, fixed: 0 }
  if (fixed > total) return { messages: 0, fixed: total / fixed }
  return { messages: Math.min(breakdown.parts.messages, total - fixed), fixed: 1 }
}

/**
 * Parse the status payload. Returns null for anything unexpected — a status
 * string is untrusted input from a subprocess, and a malformed one must
 * degrade to "no breakdown", never break the meter.
 */
export function parseContextBreakdown(statusText: string | undefined): ContextBreakdown | null {
  if (!statusText) return null
  try {
    const parsed = JSON.parse(statusText) as Partial<ContextBreakdown>
    const parts = parsed.parts
    if (!parts || typeof parts !== 'object') return null
    const num = (value: unknown): number => (typeof value === 'number' && value >= 0 ? value : 0)
    return {
      totalTokens: typeof parsed.totalTokens === 'number' ? parsed.totalTokens : null,
      contextWindow: typeof parsed.contextWindow === 'number' ? parsed.contextWindow : null,
      parts: {
        messages: num(parts.messages),
        systemPrompt: num(parts.systemPrompt),
        tools: num(parts.tools),
        mcpTools: num(parts.mcpTools),
      },
      counts: {
        tools: num(parsed.counts?.tools),
        mcpTools: num(parsed.counts?.mcpTools),
        messages: num(parsed.counts?.messages),
      },
      mcpByServer: parseByServer(parsed.mcpByServer),
      approximate: parsed.approximate !== false,
    }
  } catch {
    return null
  }
}

/**
 * Per-server MCP cost, rebuilt defensively: the extension is a separate file
 * loaded into pi, so a session started by an older Phosphor build sends a payload
 * without this key, or one without `direct` / `toolCount`. Missing means "no
 * per-server detail" or "unknown total", never zero cost.
 */
function parseByServer(raw: unknown): ContextBreakdown['mcpByServer'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ContextBreakdown['mcpByServer'] = {}
  const num = (value: unknown): number => (typeof value === 'number' && value >= 0 ? value : 0)
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name || !value || typeof value !== 'object') continue
    const record = value as Partial<McpServerCost>
    const tokens = num(record.tokens)
    const count = num(record.count)
    if (tokens === 0 && count === 0) continue
    out[name] = {
      tokens,
      count,
      direct: Math.min(count, num(record.direct)),
      toolCount:
        typeof record.toolCount === 'number' && record.toolCount >= 0 ? record.toolCount : null,
    }
  }
  return out
}

/**
 * Per-server MCP rows for the popover, largest first and fitted the same way
 * the slices are, so the numbers agree with the bar above them.
 */
export function mcpServerRows(
  breakdown: ContextBreakdown,
  total: number,
): Array<{ name: string } & McpServerCost> {
  const scale = fit(breakdown, total).fixed
  return Object.entries(breakdown.mcpByServer)
    .map(([name, value]) => ({ name, ...value, tokens: Math.round(value.tokens * scale) }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
}

/**
 * Turn a breakdown into rendered slices against the authoritative totals.
 *
 * `total` and `window` come from pi (not the extension), because pi's number
 * is the one that decides compaction. The fixed components keep their own
 * size, the message estimate is clamped to what is left of the total (see
 * `fit`), and whatever pi counts beyond them becomes the `unmeasured` slice.
 * Both remainders are honest: `unmeasured` is the part of the request this
 * process cannot see, "Free space" is the part of the window nothing occupies
 * yet.
 */
export function breakdownSlices(
  breakdown: ContextBreakdown,
  total: number,
  window: number,
): BreakdownSlice[] {
  const parts = breakdown.parts
  const fitted = fit(breakdown, total)
  const pct = (tokens: number): number => (window > 0 ? (tokens / window) * 100 : 0)

  const fixed = (tokens: number): number => Math.round(tokens * fitted.fixed)
  const slices: BreakdownSlice[] = [
    {
      key: 'messages',
      label: 'Messages',
      tokens: Math.round(fitted.messages),
      color: 'var(--px-accent)',
      count: breakdown.counts.messages,
      hint: 'Messages the model currently holds: everything since the last compaction, tool results included. The Session count below is every message in the file.',
    },
    {
      key: 'systemPrompt',
      label: 'System prompt',
      tokens: fixed(parts.systemPrompt),
      color: 'var(--px-success)',
    },
    {
      key: 'tools',
      label: 'Tools',
      tokens: fixed(parts.tools),
      color: 'var(--px-warning)',
      count: breakdown.counts.tools,
    },
    {
      key: 'mcpTools',
      label: 'MCP tools',
      tokens: fixed(parts.mcpTools),
      color: 'var(--px-danger)',
      count: breakdown.counts.mcpTools,
      hint: 'MCP schemas in the window: one gateway proxy per server plus any tools loaded directly. See the chips below for each server.',
    },
  ]
    .filter((slice) => slice.tokens > 0)
    .map((slice) => ({ ...slice, percent: pct(slice.tokens) }))

  // Computed from the ROUNDED slices, so the legend adds up to pi's total
  // exactly rather than to the total plus four rounding errors.
  const unmeasured = Math.max(0, total - slices.reduce((sum, slice) => sum + slice.tokens, 0))
  if (unmeasured > 0) {
    slices.push({
      key: 'unmeasured',
      label: 'Unmeasured',
      tokens: unmeasured,
      percent: pct(unmeasured),
      color: 'var(--px-text-tertiary)',
      hint: "Counted by pi but not visible from inside it: whatever the provider wraps around pi's context (on Claude Code, the CLI's framing of pi's tools and history) and drift between the character estimate and the real tokenizer.",
    })
  }

  const used = slices.reduce((sum, slice) => sum + slice.tokens, 0)
  const free = Math.max(0, window - used)
  slices.push({
    key: 'free',
    label: 'Free space',
    tokens: free,
    percent: pct(free),
    color: 'var(--px-border-strong)',
  })
  return slices
}
