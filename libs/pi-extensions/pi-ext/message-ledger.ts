/**
 * What the messages in a session's context really cost, read from pi's own
 * usage figures wherever they can say it.
 *
 * pi's character estimate (4 chars per token, `compaction.ts`) misses two
 * things a model's window really holds:
 *
 * - **Thinking the transcript never shows.** A Claude model streams a SUMMARY
 *   of its reasoning into the `thinking` block; the full reasoning travels in
 *   the encrypted signature and stays in the window. `usage.output` counts all
 *   of it. Measured on one Opus session: 130k output tokens against 57k of
 *   visible text, so 73k tokens of context nobody could see.
 * - **Tokenizer drift.** Code, JSON and logs run nearer 2.4 chars per token
 *   than 4, so tool output is undercounted by about 1.6x.
 *
 * Both are measurable, because consecutive requests differ by exactly what was
 * added between them. For calls k and k+1 of the same unbroken request
 * history, `input(k+1) - input(k)` is reply k plus the entries after it, in
 * real tokens. When that difference holds the whole of `output(k)`, reply k
 * was kept at full size (thinking included) and the rest is the exact size of
 * the tool results and messages in between.
 *
 * The chain only holds since the provider last rebuilt the request: after a
 * compaction, a model switch, or a fall in input big enough to mean the
 * history was replayed (pi-claude-cli replays it without thinking). Everything
 * before that point, and any pair whose figures do not add up, falls back to
 * the character estimate, divided by this session's own measured ratio rather
 * than by 4.
 */

/** The subset of pi's session entry this file reads. */
export interface LedgerEntry {
  type?: string
  timestamp?: string
  summary?: string
  content?: unknown
  message?: {
    role?: string
    content?: unknown
    command?: string
    output?: string
    model?: string
    provider?: string
    stopReason?: string
    usage?: Usage
  }
}

interface Usage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
}

export interface MessageLedger {
  /** Tokens of messages, except the measured reasoning in `thinking`. */
  tokens: number
  /**
   * Reasoning held in the window, measured from usage: a reply's output less
   * its visible text and tool calls. The transcript shows only a summary of it.
   */
  thinking: number
  /** Message entries in context. */
  count: number
  /** Chars per token used for the estimated remainder (4 when unmeasured). */
  charsPerToken: number
  /** Calls whose reply and follow-up were measured from usage, of all calls. */
  measuredCalls: number
  calls: number
}

/** pi's `ESTIMATED_IMAGE_CHARS` (compaction.ts). */
export const ESTIMATED_IMAGE_CHARS = 4800
/** pi's own ratio, used until the session has measured one. */
const DEFAULT_CHARS_PER_TOKEN = 4
/** A drop of more than this share of input means the provider rebuilt the request. */
const REBUILD_DROP = 0.2
/** Per-entry slack for role headers and tool-result framing, in tokens. */
const FRAMING_SLACK = 500
/** Below this many characters a pair says too little about the ratio. */
const RATIO_MIN_CHARS = 1000
const RATIO_MIN_SAMPLES = 3

/** pi's `estimateTextAndImageContentChars`. */
export function textAndImageChars(content: unknown): number {
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

/** An assistant message's characters, split into what it shows and its thinking summary. */
export function assistantChars(blocks: unknown): { visible: number; thinking: number } {
  let visible = 0
  let thinking = 0
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue
    const b = block as {
      type?: string
      text?: string
      thinking?: string
      name?: string
      arguments?: unknown
    }
    if (b.type === 'text' && typeof b.text === 'string') visible += b.text.length
    else if (b.type === 'thinking' && typeof b.thinking === 'string') thinking += b.thinking.length
    else if (b.type === 'toolCall') {
      visible += (b.name ?? '').length
      try {
        visible += JSON.stringify(b.arguments ?? {}).length
      } catch {
        /* unserializable arguments still cost something; name counted */
      }
    }
  }
  return { visible, thinking }
}

/** Characters pi would count for one context entry (`estimateTokens` per role). */
export function entryChars(entry: LedgerEntry): number {
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
        case 'assistant': {
          const chars = assistantChars(message.content)
          return chars.visible + chars.thinking
        }
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

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** Everything the request held before this reply. */
function inputOf(usage: Usage): number {
  return num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite)
}

/** pi's `calculateContextTokens`. */
function contextTokensOf(usage: Usage): number {
  return (
    num(usage.totalTokens) ||
    num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite)
  )
}

/** pi's `getAssistantUsage`: the replies whose usage pi itself trusts. */
function usageOf(entry: LedgerEntry): Usage | null {
  const message = entry.message
  if (entry.type !== 'message' || message?.role !== 'assistant') return null
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return null
  const usage = message.usage
  if (!usage || typeof usage !== 'object' || contextTokensOf(usage) <= 0) return null
  return usage
}

const sameModel = (a: LedgerEntry, b: LedgerEntry): boolean =>
  a.message?.model === b.message?.model && a.message?.provider === b.message?.provider

/** Has images, whose 4,800-char stand-in says nothing about the text ratio. */
const hasImage = (entry: LedgerEntry): boolean => {
  const content = entry.type === 'message' ? entry.message?.content : entry.content
  return Array.isArray(content) && content.some((b) => (b as { type?: string })?.type === 'image')
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

interface MeasuredPair {
  readonly output: number
  readonly rest: number
  readonly restChars: number
  readonly plainText: boolean
}

function rangeChars(chars: readonly number[], from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += chars[i]!
  return sum
}

/**
 * Exact size of the entries after call k, or null when the pair does not
 * add up: a different model, input that fell (a rebuild) or grew by more
 * than the entries could hold (a cache-miss spike), or a reply that was not
 * kept whole.
 */
export function measuredPairs(
  entries: readonly LedgerEntry[],
  chars: readonly number[],
  calls: readonly number[],
): (MeasuredPair | null)[] {
  return calls.slice(0, -1).map((at, k) => {
    const next = calls[k + 1]!
    const usage = usageOf(entries[at]!)!
    const nextUsage = usageOf(entries[next]!)!
    const output = num(usage.output)
    const rest = inputOf(nextUsage) - inputOf(usage) - output
    const restChars = rangeChars(chars, at + 1, next)
    if (!sameModel(entries[at]!, entries[next]!)) return null
    if (rest < 0 || rest > restChars + FRAMING_SLACK * (next - at)) return null
    return { output, rest, restChars, plainText: !entries.slice(at + 1, next).some(hasImage) }
  })
}

export function measuredRatio(pairs: readonly (MeasuredPair | null)[]): number {
  const samples = pairs
    .filter((pair) => pair && pair.plainText && pair.restChars >= RATIO_MIN_CHARS && pair.rest > 0)
    .map((pair) => pair!.restChars / pair!.rest)
  return samples.length >= RATIO_MIN_SAMPLES
    ? Math.min(DEFAULT_CHARS_PER_TOKEN, Math.max(1, median(samples)))
    : DEFAULT_CHARS_PER_TOKEN
}

/** The request was last rebuilt here; only pairs from here on are still in it. */
export function rebuildAnchor(entries: readonly LedgerEntry[], calls: readonly number[]): number {
  const compactedAt = entries[0]?.type === 'compaction' ? entries[0].timestamp : undefined
  let anchor = 0
  calls.forEach((at, k) => {
    const entry = entries[at]!
    if (compactedAt && entry.timestamp && entry.timestamp < compactedAt) {
      anchor = k + 1
      return
    }
    if (k === 0) return
    const previous = entries[calls[k - 1]!]!
    if (
      !sameModel(previous, entry) ||
      inputOf(usageOf(entry)!) < (1 - REBUILD_DROP) * inputOf(usageOf(previous)!)
    ) {
      anchor = k
    }
  })
  return anchor
}

const estimate = (charCount: number, charsPerToken: number): number =>
  Math.ceil(charCount / charsPerToken)

/** A reply's exact size, split into what it shows and the reasoning it holds. */
export function splitReply(
  entry: LedgerEntry,
  size: number,
  charsPerToken: number,
): { visible: number; hidden: number } {
  // The summary is not what the model holds; the full reasoning is, and it
  // is the remainder of the output.
  const visible = Math.min(
    size,
    estimate(assistantChars(entry.message?.content).visible, charsPerToken),
  )
  return { visible, hidden: size - visible }
}

export function accumulateLedger(
  entries: readonly LedgerEntry[],
  chars: readonly number[],
  calls: readonly number[],
  pairs: readonly (MeasuredPair | null)[],
  anchor: number,
  charsPerToken: number,
): Pick<MessageLedger, 'tokens' | 'thinking' | 'measuredCalls'> {
  if (anchor >= calls.length) {
    return {
      tokens: estimate(rangeChars(chars, 0, entries.length), charsPerToken),
      thinking: 0,
      measuredCalls: 0,
    }
  }

  let tokens = estimate(rangeChars(chars, 0, calls[anchor]!), charsPerToken)
  let thinking = 0
  let measuredCalls = 0
  for (let k = anchor; k < calls.length; k++) {
    const at = calls[k]!
    const pair = k < calls.length - 1 ? pairs[k] : undefined
    if (k === calls.length - 1) {
      // pi's total holds the last reply only as far as its usage does: some
      // providers' totalTokens leave the output out, and then so do we.
      const usage = usageOf(entries[at]!)!
      const reply = splitReply(entries[at]!, contextTokensOf(usage) - inputOf(usage), charsPerToken)
      tokens += reply.visible + estimate(rangeChars(chars, at + 1, entries.length), charsPerToken)
      thinking += reply.hidden
    } else if (pair) {
      const reply = splitReply(entries[at]!, pair.output, charsPerToken)
      tokens += reply.visible + pair.rest
      thinking += reply.hidden
      measuredCalls++
    } else {
      tokens += estimate(rangeChars(chars, at, calls[k + 1]!), charsPerToken)
    }
  }
  return { tokens, thinking, measuredCalls }
}

/**
 * Measure pi's context entries (`buildContextEntries()`: a compaction applied,
 * so it is the only cut). With no usage at all this is pi's own estimate.
 */
export function measureMessages(entries: LedgerEntry[]): MessageLedger {
  const count = entries.filter((entry) => entry.type === 'message').length
  const chars = entries.map(entryChars)
  const calls: number[] = []
  entries.forEach((entry, index) => {
    if (usageOf(entry)) calls.push(index)
  })
  const pairs = measuredPairs(entries, chars, calls)
  const charsPerToken = measuredRatio(pairs)
  const anchor = rebuildAnchor(entries, calls)
  const { tokens, thinking, measuredCalls } = accumulateLedger(
    entries,
    chars,
    calls,
    pairs,
    anchor,
    charsPerToken,
  )
  return { tokens, thinking, count, charsPerToken, measuredCalls, calls: calls.length }
}
