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

export interface ContextBreakdown {
  totalTokens: number | null
  contextWindow: number | null
  parts: { messages: number; systemPrompt: number; tools: number; mcpTools: number }
  counts: { tools: number; mcpTools: number; messages: number }
  /** Approximate MCP schema cost per server. Absent from older payloads. */
  mcpByServer: Record<string, { tokens: number; count: number }>
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
 * the Claude Code CLI sends its own system prompt and its own native tool
 * schemas too, and keeps native tool results in its own transcript. Measured
 * live on 2026-09-09, that unattributable share was ~29k tokens on turn 1 of
 * a Claude session and ~0.5k on a native one.
 *
 * It must be shown as its own slice, never spread across the measured ones.
 * See `scaleFor`.
 */
export function measuredTokens(breakdown: ContextBreakdown): number {
  const p = breakdown.parts
  return p.messages + p.systemPrompt + p.tools + p.mcpTools
}

/**
 * Estimates are scaled DOWN to fit pi's total, and never up.
 *
 * Down is honest: `~4 characters per token` can overshoot, and a component
 * cannot occupy more of the window than the whole request does.
 *
 * Up is not. Scaling up assumes every token pi counts belongs to something
 * this extension measured, which is false for any CLI provider — so the
 * provider's own prompt and tool schemas were silently added to *our* slices.
 * A fixed 9,914-token system prompt rendered as 44.1k then 22.5k across four
 * turns of one Claude session, drifting with the provider's hidden share, while
 * the same code stayed within ~8% on a native pi session. The remainder is the
 * `unmeasured` slice instead.
 */
function scaleFor(measured: number, total: number): number {
  return measured > total && measured > 0 ? total / measured : 1
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
 * without this key. Missing means "no per-server detail", never zero cost.
 */
function parseByServer(raw: unknown): ContextBreakdown['mcpByServer'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ContextBreakdown['mcpByServer'] = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name || !value || typeof value !== 'object') continue
    const record = value as { tokens?: unknown; count?: unknown }
    const tokens = typeof record.tokens === 'number' && record.tokens >= 0 ? record.tokens : 0
    const count = typeof record.count === 'number' && record.count >= 0 ? record.count : 0
    if (tokens === 0 && count === 0) continue
    out[name] = { tokens, count }
  }
  return out
}

/**
 * Per-server MCP rows for the popover, largest first and scaled the same way
 * the slices are, so the numbers agree with the bar above them.
 */
export function mcpServerRows(
  breakdown: ContextBreakdown,
  total: number,
): Array<{ name: string; tokens: number; count: number }> {
  const scale = scaleFor(measuredTokens(breakdown), total)
  return Object.entries(breakdown.mcpByServer)
    .map(([name, value]) => ({
      name,
      tokens: Math.round(value.tokens * scale),
      count: value.count,
    }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
}

/**
 * Turn a breakdown into rendered slices against the authoritative totals.
 *
 * `total` and `window` come from pi (not the extension), because pi's number
 * is the one that decides compaction. The measured components keep their own
 * size (clamped down to fit — see `scaleFor`), and whatever pi counts beyond
 * them becomes the `unmeasured` slice. Both remainders are honest: `unmeasured`
 * is the part of the request this process cannot see, "Free space" is the part
 * of the window nothing occupies yet.
 */
export function breakdownSlices(
  breakdown: ContextBreakdown,
  total: number,
  window: number,
): BreakdownSlice[] {
  const parts = breakdown.parts
  const scale = total > 0 ? scaleFor(measuredTokens(breakdown), total) : 0
  const pct = (tokens: number): number => (window > 0 ? (tokens / window) * 100 : 0)

  const scaled = (tokens: number): number => Math.round(tokens * scale)
  const slices: BreakdownSlice[] = [
    {
      key: 'messages',
      label: 'Messages',
      tokens: scaled(parts.messages),
      color: 'var(--px-accent)',
      count: breakdown.counts.messages,
    },
    {
      key: 'systemPrompt',
      label: 'System prompt',
      tokens: scaled(parts.systemPrompt),
      color: 'var(--px-success)',
    },
    {
      key: 'tools',
      label: 'Tools',
      tokens: scaled(parts.tools),
      color: 'var(--px-warning)',
      count: breakdown.counts.tools,
    },
    {
      key: 'mcpTools',
      label: 'MCP tools',
      tokens: scaled(parts.mcpTools),
      color: 'var(--px-danger)',
      count: breakdown.counts.mcpTools,
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
      hint: "Counted by pi but not visible from inside it. On a CLI provider this is the CLI's own system prompt, its native tool schemas and results it keeps in its own transcript; elsewhere it is drift between the character estimate and the real tokenizer.",
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
