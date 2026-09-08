/**
 * pidex headroom extension — loaded into every pidex session via
 * `pi --mode rpc -e <this file>`, alongside the other bundled extensions.
 *
 * Compresses large tool results through a local Headroom proxy
 * (https://github.com/headroomlabs-ai/headroom) at the moment they are
 * produced, on pi's `tool_result` hook. A compressed result is written once
 * and never rewritten, so every earlier message keeps its exact bytes and
 * the provider's prefix cache cannot break — the reason this design was
 * chosen over routing model traffic through the proxy (see
 * docs/specs/headroom-compression.md).
 *
 * Inert by default: it does nothing unless `PIDEX_HEADROOM_URL` is set, and
 * it fails open — any proxy failure disables it for the session and the
 * original tool result passes through untouched. A compression service must
 * never be able to break a turn.
 *
 * Only JSON is compressed, and that rule is load-bearing. Measured against
 * a 0.37.0 proxy with the ml+code extras (2026-09-07): plain text goes to
 * transforms that are lossy WITHOUT saying so — `code_aware` kept 3% of a
 * grep result, `kompress` deleted words from `git log` prose ("design the
 * Optimization surface" → "design Optimization surface") — no marker, no
 * hash, nothing to detect after the fact. Valid JSON, by contrast, is
 * lossless-or-noop on this endpoint by construction: SmartCrusher's
 * lossless path RESTRUCTURES uniform arrays into a typed header + CSV rows
 * (verified 120/500/2000 records intact), and its lossy row-sampling path
 * is suppressed when no CCR store exists — heterogeneous JSON comes back
 * `router:noop`, byte-identical. So the gate is one JSON.parse, enforceable
 * here regardless of how the proxy pidex adopted happens to be configured.
 * The omission-marker check below stays as the second layer, and the
 * pidex-managed proxy additionally pins HEADROOM_COMPRESSORS to the
 * lossless families — three independent defenses.
 *
 * Every accepted compression writes a receipt into the result's `details`
 * (`details.headroom`), which pi persists into the session file — that is
 * what the Optimization surface folds for per-lane savings
 * (docs/specs/optimization-surface.md).
 *
 * On the Claude Code provider only pi's own tools reach this hook (MCP and
 * custom tools, via the handoff broker); the CLI's built-ins never do.
 */

// Loose structural types: the real ones live in @earendil-works/pi-coding-agent,
// which is provided by pi at load time (not a pidex dependency).
interface PiExtensionApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
}

interface ToolResultEvent {
  toolName?: string
  content?: unknown
  details?: unknown
  isError?: boolean
}

interface ExtensionContext {
  signal?: AbortSignal
  model?: { id?: unknown }
  ui?: { setStatus?(key: string, text: string | undefined): void }
}

export const HEADROOM_STATUS_KEY = 'pidex-headroom'

/**
 * Never compressed, even when their output happens to be JSON: a `read` of a
 * .json file is code being fetched to be worked on, not a record set.
 */
const EXCLUDED_TOOLS = new Set(['read', 'write', 'edit', 'bash'])

/** JSON.parse ceiling — beyond this the parse itself is the cost. */
const MAX_PARSE_CHARS = 2_000_000

/** ~1k tokens. Below this the round-trip costs more than it saves. */
const MIN_CHARS = 4000

const COMPRESS_TIMEOUT_MS = 3000
const HEALTH_TIMEOUT_MS = 1500
/** Consecutive proxy failures before the session gives up on it. */
const MAX_FAILURES = 3

/** Cumulative per-session counters, pushed as JSON on the status channel. */
export interface HeadroomTotals {
  savedTokens: number
  beforeTokens: number
  afterTokens: number
  results: number
  /** Potential savings discarded because the transform was lossy. */
  skippedLossyTokens: number
  lastMs: number
}

/**
 * The single text block this extension is willing to rewrite, or null.
 *
 * Deliberately narrow: exactly one `{type:"text"}` block, nothing else, and
 * the text must parse as a JSON object or array (see the header — plain text
 * is where the silently-lossy transforms live). Multi-block results keep
 * their structure; error results keep their text because the error IS the
 * payload. pi truncates oversized MCP output mid-byte, so a big result that
 * fails to parse here is usually pi's own truncation — refusing it is
 * correct twice over.
 */
export function eligibleText(event: ToolResultEvent, minChars = MIN_CHARS): string | null {
  if (event.isError) return null
  const tool = event.toolName
  if (!tool || EXCLUDED_TOOLS.has(tool)) return null
  const content = event.content
  if (!Array.isArray(content) || content.length !== 1) return null
  const block = content[0] as { type?: unknown; text?: unknown }
  if (block?.type !== 'text' || typeof block.text !== 'string') return null
  const text = block.text
  if (text.length < minChars || text.length > MAX_PARSE_CHARS) return null
  const head = text.trimStart()[0]
  if (head !== '{' && head !== '[') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return null
  } catch {
    return null
  }
  return text
}

/**
 * True when the compressed text admits it dropped lines and offers no way to
 * get them back. Upstream's lossy transforms emit markers like
 * `[2711 lines omitted: 3 ERROR, 2725 INFO]`; the retrievable variant
 * carries a `hash=` reference. Enforceable from the response alone, so it
 * survives any upstream config change.
 */
export function hasUnretrievableOmission(text: string): boolean {
  return /\[\d[\d,]*\s+lines?\s+omitted/i.test(text) && !text.includes('hash=')
}

/** `details` patch that keeps whatever the tool already recorded. */
export function mergeDetails(
  existing: unknown,
  receipt: { savedTokens: number; beforeTokens: number; afterTokens: number; ms: number },
): Record<string, unknown> {
  const base =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}
  return { ...base, headroom: receipt }
}

interface CompressResponse {
  messages?: Array<{ content?: unknown }>
  tokens_before?: number
  tokens_after?: number
  tokens_saved?: number
}

/**
 * The `tool_result` handler, with the HTTP boundary injected for tests.
 * One instance per session; state is the health verdict, the failure count
 * and the cumulative totals.
 */
export function createHeadroomHandler(deps: {
  baseUrl: string
  fetchImpl: typeof fetch
}): (rawEvent: unknown, rawCtx: unknown) => Promise<Record<string, unknown> | undefined> {
  const baseUrl = deps.baseUrl.replace(/\/+$/, '')
  let enabled = true
  let healthChecked = false
  let failures = 0
  const totals: HeadroomTotals = {
    savedTokens: 0,
    beforeTokens: 0,
    afterTokens: 0,
    results: 0,
    skippedLossyTokens: 0,
    lastMs: 0,
  }

  const pushStatus = (ctx: ExtensionContext): void => {
    const setStatus = ctx.ui?.setStatus
    if (typeof setStatus !== 'function') return
    try {
      setStatus.call(ctx.ui, HEADROOM_STATUS_KEY, JSON.stringify(totals))
    } catch {
      // Status is decoration; never let it disturb the result path.
    }
  }

  return async (rawEvent, rawCtx) => {
    if (!enabled) return
    const event = rawEvent as ToolResultEvent
    const ctx = (rawCtx ?? {}) as ExtensionContext
    const text = eligibleText(event)
    if (text === null) return

    // One health probe per session, paid by the first eligible result. A
    // proxy that is down must cost one failed fetch, not one per tool call.
    if (!healthChecked) {
      healthChecked = true
      try {
        const health = await deps.fetchImpl(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        })
        if (!health.ok) throw new Error(`health ${health.status}`)
      } catch {
        enabled = false
        return
      }
    }

    const started = Date.now()
    let response: CompressResponse
    try {
      const signals = [AbortSignal.timeout(COMPRESS_TIMEOUT_MS)]
      if (ctx.signal) signals.push(ctx.signal)
      const res = await deps.fetchImpl(`${baseUrl}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'tool', content: text }],
          model: typeof ctx.model?.id === 'string' ? ctx.model.id : 'claude-sonnet-4-5',
        }),
        signal: AbortSignal.any(signals),
      })
      if (!res.ok) throw new Error(`compress ${res.status}`)
      response = (await res.json()) as CompressResponse
    } catch {
      // Esc during the turn aborts ctx.signal; that is not a proxy failure.
      if (ctx.signal?.aborted) return
      failures += 1
      if (failures >= MAX_FAILURES) enabled = false
      return
    }
    failures = 0

    const compressed = response.messages?.[0]?.content
    if (typeof compressed !== 'string' || compressed.length >= text.length) return
    const savedTokens = response.tokens_saved ?? 0

    if (hasUnretrievableOmission(compressed)) {
      // Lossy and irreversible here — keep the original, count the ceiling.
      totals.skippedLossyTokens += savedTokens
      pushStatus(ctx)
      return
    }

    const ms = Date.now() - started
    totals.savedTokens += savedTokens
    totals.beforeTokens += response.tokens_before ?? 0
    totals.afterTokens += response.tokens_after ?? 0
    totals.results += 1
    totals.lastMs = ms
    pushStatus(ctx)

    return {
      content: [{ type: 'text', text: compressed }],
      details: mergeDetails(event.details, {
        savedTokens,
        beforeTokens: response.tokens_before ?? 0,
        afterTokens: response.tokens_after ?? 0,
        ms,
      }),
    }
  }
}

export default function headroomExtension(pi: PiExtensionApi): void {
  const baseUrl = process.env.PIDEX_HEADROOM_URL
  if (!baseUrl) return
  pi.on('tool_result', createHeadroomHandler({ baseUrl, fetchImpl: fetch }))
}
