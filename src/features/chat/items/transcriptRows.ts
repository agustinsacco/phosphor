import type { AssistantBlock, AssistantItem, ChatItem, ToolState } from '../reducer'

/**
 * Turn-level transcript grouping.
 *
 * pi emits ONE assistant message per tool call (verified across 356 real
 * assistant messages: 302 carried exactly one). Grouping inside a single
 * message therefore can never collapse a tool run — every call lands as its
 * own top-level row paying full inter-message spacing, which is why runs of
 * 3–18 calls used to march down the page.
 *
 * So grouping happens here, ACROSS message boundaries: a contiguous run of
 * assistant thinking + tool activity becomes one `activity` row no matter how
 * many messages produced it. Prose, user messages, bash and dividers stay
 * their own rows, which also keeps ordering intact.
 *
 * Pure and independent of React so the virtualizer can key off the result and
 * the behavior stays unit-testable.
 */

/**
 * A tool Claude Code ran INSIDE its own process (WebSearch, WebFetch,
 * ToolSearch, the user's MCP servers, sub-agents) while acting as pi's model
 * provider. pi never sees these as tool calls — it cannot execute them — so
 * the provider extension reports them as one-line marker text blocks. They
 * are real activity, so they belong in the activity group next to pi's own
 * tools rather than in the prose lane, where the raw JSON wrapped across
 * paragraphs and any URL inside it got auto-linkified as markdown.
 */
export interface ExternalToolBlock {
  type: 'externalTool'
  index: number
  /** Tool name as Claude Code reported it, e.g. "WebSearch". */
  name: string
  /**
   * Argument preview, verbatim from the marker. Read best-effort by
   * `externalToolInfo`; never a hard dependency. Complete JSON on provider
   * >= 0.8.0, a document cut at 120 characters below it.
   */
  args?: string
  /**
   * The CLI's `tool_use_id`, present only when the provider tagged the call
   * — which it does when the host set `PI_CLAUDE_CLI_TOOL_RESULTS=1`. Its
   * presence is what promises a result marker is coming.
   */
  toolUseId?: string
  /** Folded in from the paired `result` marker, once it arrives. */
  result?: ExternalToolResult
}

/**
 * What came back from a tool the CLI ran itself.
 *
 * Everything here is the provider's own summary of the outcome — Phosphor
 * measures nothing. `summary` is printable as-is ("419 lines", "+1 -1 in
 * poem.txt", "exit 1 · No such file or directory"); the metric fields are
 * whatever the tool made available, so a row must degrade when they are
 * absent (a provider below 0.8.0 sends only `preview`/`length`).
 */
export interface ExternalToolResult {
  status: 'ok' | 'error'
  /** One-line outcome, ready to render. */
  summary?: string
  /** The failure message, when the call failed. */
  error?: string
  /** Output preview, capped by the provider at 2,000 characters. */
  preview?: string
  /** Full output size in characters, even when `preview` is shorter. */
  length?: number
  /** `preview` is shorter than `length`. */
  truncated?: boolean
}

/** `[Claude Code · WebSearch {"query":"…"}]` → name + argument preview. */
const EXTERNAL_TOOL_MARKER = /^\[Claude Code · ([^\s\]]+)(?:\s+([\s\S]*))?\]$/

/**
 * The id tag the provider puts in front of the arguments when result
 * forwarding is on: `[Claude Code · Read #toolu_01A {"file_path":…}]`.
 */
const MARKER_ID_TAG = /^#(\S+)\s*([\s\S]*)$/

/** The name a result marker wears: `[Claude Code · result #<id> {…}]`. */
const RESULT_MARKER_NAME = 'result'

export function parseExternalToolMarker(
  text: string,
): { name: string; toolUseId?: string; args?: string } | null {
  const match = EXTERNAL_TOOL_MARKER.exec(text.trim())
  if (!match) return null
  const rest = match[2]?.trim()
  const tagged = rest ? MARKER_ID_TAG.exec(rest) : null
  const args = (tagged ? tagged[2]?.trim() : rest) || undefined
  return {
    name: match[1]!,
    toolUseId: tagged?.[1],
    args,
  }
}

export function isResultMarker(name: string): boolean {
  return name === RESULT_MARKER_NAME
}

/**
 * Read a result marker's payload.
 *
 * Unlike the call marker's arguments, this payload has always been complete
 * JSON, so it is parsed strictly: a payload that does not parse is a provider
 * this renderer does not understand, and inventing a status from fragments
 * would put a wrong outcome on a row.
 */
export function parseResultPayload(args: string | undefined): ExternalToolResult | null {
  if (!args) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const payload = parsed as Record<string, unknown>
  const str = (key: string): string | undefined =>
    typeof payload[key] === 'string' && payload[key] !== '' ? (payload[key] as string) : undefined
  return {
    status: payload.status === 'error' ? 'error' : 'ok',
    summary: str('summary'),
    error: str('error'),
    preview: typeof payload.preview === 'string' ? payload.preview : undefined,
    length: typeof payload.length === 'number' ? payload.length : undefined,
    truncated: payload.truncated === true,
  }
}

/**
 * Claude Code's sub-agent tools, as they appear in marker blocks.
 *
 * `Agent` is the model's own tool call. `Task` is the CLI's lifecycle
 * channel, which reports the SAME agent again when it starts and once more
 * when it finishes. Three markers, one agent — counting these as three
 * launches is how a three-agent fan-out reported "8 sub-agents were started".
 * `buildTranscriptRows` folds them; see `agentMarkerInfo`.
 */
const AGENT_MARKER_NAMES = new Set(['Agent', 'Task'])

export function isAgentMarker(name: string): boolean {
  return AGENT_MARKER_NAMES.has(name)
}

/**
 * Where a sub-agent got to, as far as the transcript can prove.
 *
 * `launched` is the model's tool call with no lifecycle event yet; `running`
 * is a `task_started` the CLI confirmed. They are kept apart because the gap
 * between them is exactly the failure this rendering exists to expose: a
 * `launched` row that never became anything is an agent that died with the
 * CLI (provider < 0.4.14).
 */
export type SubagentStatus = 'launched' | 'running' | 'completed' | 'stopped' | 'failed'

/** Statuses that mean the agent is not coming back, for better or worse. */
const TERMINAL_AGENT_STATUSES = new Set<SubagentStatus>(['completed', 'stopped', 'failed'])

export function isTerminalAgentStatus(status: SubagentStatus): boolean {
  return TERMINAL_AGENT_STATUSES.has(status)
}

/**
 * One sub-agent, folded from every marker that mentions it.
 *
 * Not an `externalTool` block: those are one row per marker, always settled,
 * with no status. A sub-agent is one row per AGENT that changes state as the
 * CLI reports on it — which only became possible when the provider started
 * letting agents finish (`pi-claude-cli` 0.4.14).
 */
export interface SubagentBlock {
  type: 'subagent'
  /** Index of the FIRST marker that produced this agent, for row keying. */
  index: number
  status: SubagentStatus
  /** The CLI's task id, once a lifecycle event names it. */
  taskId?: string
  description?: string
  subagentType?: string
  /** The launch prompt, when it survived the provider's preview cap. */
  prompt?: string
  toolUses?: number
  totalTokens?: number
  durationMs?: number
  /**
   * Which markers have already been folded in. A fan-out routinely launches
   * several agents under ONE description ("Explore the codebase" x3), so
   * "same description" cannot mean "same agent" on its own — but a second
   * `Agent` call for a description that already has one must start a new row.
   */
  seen: Set<AgentMarkerPhase>
}

/** The three markers a single sub-agent produces, in order. */
export type AgentMarkerPhase = 'call' | 'start' | 'end'

export interface AgentMarkerInfo {
  phase: AgentMarkerPhase
  status: SubagentStatus
  taskId?: string
  description?: string
  subagentType?: string
  prompt?: string
  toolUses?: number
  totalTokens?: number
  durationMs?: number
}

/**
 * A description that is really a raw task id.
 *
 * `task_notification` carries no description, and provider 0.4.13 filled that
 * hole with the task id — so a late notification rendered as an AGENT row
 * named `a8de7d982d824b56a`. 0.4.14 drops those events instead, but sessions
 * recorded before it are on disk forever, so the id is recognised and
 * suppressed rather than shown as a name.
 */
const RAW_TASK_ID = /^[0-9a-f]{12,}$/i

const num = (value: string | number | undefined): number | undefined =>
  typeof value === 'number' ? value : undefined

/** Read one `Agent` / `Task` marker into the lifecycle it reports. */
export function agentMarkerInfo(name: string, args?: string): AgentMarkerInfo {
  const fields = args ? parseMarkerFields(args) : {}
  const str = (key: string): string | undefined => {
    const value = fields[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const rawStatus = str('status')
  const description = str('description')
  const phase: AgentMarkerPhase =
    name === 'Agent' ? 'call' : rawStatus === 'started' ? 'start' : 'end'
  const status: SubagentStatus =
    phase === 'call'
      ? 'launched'
      : phase === 'start'
        ? 'running'
        : rawStatus === 'completed'
          ? 'completed'
          : rawStatus === 'stopped'
            ? 'stopped'
            : 'failed'

  return {
    phase,
    status,
    taskId: str('task_id'),
    description: description && !RAW_TASK_ID.test(description) ? description : undefined,
    subagentType: str('subagent_type'),
    prompt: str('prompt'),
    toolUses: num(fields['tool_uses']),
    totalTokens: num(fields['total_tokens']),
    durationMs: num(fields['duration_ms']),
  }
}

/** Rank so a later marker can never walk a finished agent back to "launched". */
const STATUS_RANK: Record<SubagentStatus, number> = {
  launched: 0,
  running: 1,
  completed: 2,
  stopped: 2,
  failed: 2,
}

/**
 * Folds every marker for one sub-agent into a single block.
 *
 * The join is `task_id` when the provider sends one (0.4.14+). Older sessions
 * have only the description, so those fall back to pairing by description:
 * each block absorbs at most one marker of each phase, in launch order, which
 * keeps three same-named parallel agents as three rows instead of one.
 */
function createAgentFolder(): (info: AgentMarkerInfo, index: number) => SubagentBlock | null {
  const byTaskId = new Map<string, SubagentBlock>()
  const byDescription = new Map<string, SubagentBlock[]>()

  const absorb = (block: SubagentBlock, info: AgentMarkerInfo): void => {
    block.seen.add(info.phase)
    if (STATUS_RANK[info.status] >= STATUS_RANK[block.status]) block.status = info.status
    block.taskId ??= info.taskId
    block.description ??= info.description
    block.subagentType ??= info.subagentType
    block.prompt ??= info.prompt
    block.toolUses ??= info.toolUses
    block.totalTokens ??= info.totalTokens
    block.durationMs ??= info.durationMs
    if (info.taskId && !byTaskId.has(info.taskId)) byTaskId.set(info.taskId, block)
  }

  return (info, index) => {
    const known = info.taskId ? byTaskId.get(info.taskId) : undefined
    if (known) {
      absorb(known, info)
      return null
    }

    if (info.description) {
      const candidates = byDescription.get(info.description) ?? []
      const match = candidates.find((block) => !block.seen.has(info.phase))
      if (match) {
        absorb(match, info)
        return null
      }
    }

    const block: SubagentBlock = {
      type: 'subagent',
      index,
      status: info.status,
      taskId: info.taskId,
      description: info.description,
      subagentType: info.subagentType,
      prompt: info.prompt,
      toolUses: info.toolUses,
      totalTokens: info.totalTokens,
      durationMs: info.durationMs,
      seen: new Set([info.phase]),
    }
    if (info.taskId) byTaskId.set(info.taskId, block)
    if (info.description) {
      const list = byDescription.get(info.description)
      if (list) list.push(block)
      else byDescription.set(info.description, [block])
    }
    return block
  }
}

/** What an external-tool row should actually say, instead of raw JSON. */
export interface ExternalToolInfo {
  /** A Claude Code sub-agent launch (Agent/Task). */
  isAgent: boolean
  /** Human headline: the agent's description, or the primary argument. */
  headline?: string
  /** Longer secondary text (the agent's prompt), when recoverable. */
  detail?: string
  /**
   * Every argument that survived the preview cap, unescaped. Exposed so the
   * row can be summarized with the same vocabulary as a pi tool call rather
   * than re-parsing the marker somewhere else.
   */
  fields: Record<string, string>
}

/** Argument keys worth surfacing, most meaningful first. */
const HEADLINE_KEYS = [
  'description',
  'query',
  'url',
  'path',
  'file_path',
  'command',
  'pattern',
  'skill',
  'prompt',
]

/** The JSON single-character escapes (`\uXXXX` handled separately). */
const JSON_FRAGMENT_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/**
 * Unescape a marker field one escape at a time — never by round-tripping the
 * whole value through `JSON.parse('"…"')`.
 *
 * The round-trip version threw on the FIRST invalid sequence and returned the
 * entire string raw, so every other escape stayed literal too. And invalid
 * sequences are routine here, because the provider caps the args preview at
 * 120 characters: a cap landing just after a backslash leaves `\…` (the
 * provider's own ellipsis riding an orphaned escape), which poisoned commands
 * whose only sin was being long — every `\n` in them rendered as two visible
 * characters. One bad escape must cost itself, not the string.
 */
function unescapeJsonFragment(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (char !== '\\') {
      out += char
      continue
    }
    const next = value[i + 1]
    // A lone trailing backslash: the cap cut mid-escape. Drop it.
    if (next === undefined) break
    const simple = JSON_FRAGMENT_ESCAPES[next]
    if (simple !== undefined) {
      out += simple
      i++
      continue
    }
    if (next === 'u') {
      const hex = value.slice(i + 2, i + 6)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 5
        continue
      }
      // A half-written \uXX at the very end is the cap again: drop it.
      // Mid-string, an invalid \u stays literal like any other bad escape.
      if (i + 6 > value.length && /^[0-9a-fA-F]*$/.test(hex)) break
    }
    // Not a JSON escape. Keep both characters literally.
    out += char + next
    i++
  }
  return out
}

/**
 * Best-effort read of a marker's argument preview, keeping numbers as numbers.
 *
 * The provider caps the preview, so `args` is often TRUNCATED mid-string and
 * `JSON.parse` fails; the fallback pulls out whichever complete `"key":"value"`
 * pairs survived. Values are unescaped through JSON.parse per field so `\"`
 * and `\n` read naturally.
 *
 * The numeric scan exists for the sub-agent lifecycle markers, whose whole
 * payload is numbers — `tool_uses`, `total_tokens`, `duration_ms`. A
 * string-only reader dropped every one of them silently, so a finished agent
 * had nothing to show for itself.
 */
function parseMarkerFields(args: string): Record<string, string | number> {
  const fields: Record<string, string | number> = {}
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' || typeof value === 'number') fields[key] = value
      }
    }
    return fields
  } catch {
    // Truncated preview: recover pair by pair below.
  }

  const pair = /"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  for (let match = pair.exec(args); match; match = pair.exec(args)) {
    fields[match[1]!] = unescapeJsonFragment(match[2]!)
  }
  // A number is only trustworthy when the cap did not land inside it, so it
  // must be followed by the delimiter that proves it ended.
  const numeric = /"([^"\\]+)"\s*:\s*(-?\d+(?:\.\d+)?)\s*(?=[,}])/g
  for (let match = numeric.exec(args); match; match = numeric.exec(args)) {
    if (fields[match[1]!] === undefined) fields[match[1]!] = Number(match[2])
  }
  // The pair scan needs a CLOSING quote, so a tool whose only interesting
  // argument is the one the cap cut through recovers nothing at all. That
  // is the common case, not an edge case: every `Bash` marker carries just
  // `command`, so a long command rendered as a bare "Claude Code Bash" row
  // with the command — the entire content of the row — missing.
  // The trailing `\\?` matters: a cut landing right after a backslash leaves
  // one with nothing to escape, which `\\.` cannot consume.
  const dangling = /"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*\\?)$/.exec(args)
  if (dangling && fields[dangling[1]!] === undefined) {
    fields[dangling[1]!] = unescapeJsonFragment(dangling[2]!)
  }
  return fields
}

/**
 * Best-effort read of a marker's argument preview.
 *
 * Strings only: every caller renders these as text, and a number reaching a
 * `Record<string, string>` would be a lie the type system stopped catching.
 * Sub-agent rows read the numeric fields through `agentMarkerInfo`.
 */
export function externalToolInfo(name: string, args?: string): ExternalToolInfo {
  const isAgent = isAgentMarker(name)
  if (!args) return { isAgent, fields: {} }

  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseMarkerFields(args))) {
    if (typeof value === 'string') fields[key] = value
  }

  if (isAgent) {
    return {
      isAgent,
      fields,
      headline: fields['description'] || fields['subagent_type'] || undefined,
      detail: fields['prompt'] || undefined,
    }
  }
  const key = HEADLINE_KEYS.find((k) => fields[k])
  return { isAgent, fields, headline: key ? fields[key] : undefined }
}

export interface ActivityStep {
  /** Owning assistant item — needed for streaming/stop-reason context. */
  itemId: string
  block: Exclude<AssistantBlock, { type: 'text' }> | ExternalToolBlock | SubagentBlock
  /** The owning item is still streaming. */
  streaming: boolean
  /** This block is the last one in its message (streaming tail detection). */
  isLastInItem: boolean
}

export type TranscriptRow =
  /** A non-assistant item, or one assistant prose block, rendered as-is. */
  | { kind: 'item'; id: string; item: ChatItem }
  | {
      kind: 'text'
      id: string
      item: AssistantItem
      block: Extract<AssistantBlock, { type: 'text' }>
      isLastInItem: boolean
    }
  | { kind: 'activity'; id: string; steps: ActivityStep[] }
  /** Error / aborted tail of an assistant message. */
  | { kind: 'outcome'; id: string; item: AssistantItem }

/**
 * Flatten chat items into renderable rows, merging consecutive assistant
 * activity across messages.
 */
export function buildTranscriptRows(items: ChatItem[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  // One folder per transcript: an agent launched in one message finishes in
  // the next, so the join has to outlive a single item.
  const foldAgent = createAgentFolder()
  /**
   * Calls awaiting their result marker, by `tool_use_id`.
   *
   * A result marker is NOT a row: it is the second half of the row its call
   * already produced, and the CLI can report it messages later (a tool called
   * in one episode of a turn reports in the next). Same reason the agent
   * folder outlives an item.
   */
  const awaitingResult = new Map<string, ExternalToolBlock>()

  /** Append to the open activity row, or start one. */
  const pushStep = (step: ActivityStep): void => {
    const last = rows[rows.length - 1]
    if (last?.kind === 'activity') {
      last.steps.push(step)
      return
    }
    rows.push({ kind: 'activity', id: `act-${step.itemId}-${step.block.index}`, steps: [step] })
  }

  for (const item of items) {
    if (item.kind !== 'assistant') {
      rows.push({ kind: 'item', id: item.id, item })
      continue
    }

    const lastIndex = item.blocks[item.blocks.length - 1]?.index
    for (const block of item.blocks) {
      const isLastInItem = block.index === lastIndex
      if (block.type === 'text') {
        const marker = parseExternalToolMarker(block.text)
        if (marker) {
          if (isAgentMarker(marker.name)) {
            // Three markers per agent, one row. A marker folded into an
            // agent that already has a row adds no step — which is the
            // point: the row it belongs to updates in place, wherever it
            // is, instead of a "completed" row appearing pages later.
            const agent = foldAgent(agentMarkerInfo(marker.name, marker.args), block.index)
            if (agent) {
              pushStep({
                itemId: item.id,
                block: agent,
                streaming: item.streaming,
                isLastInItem,
              })
            }
            continue
          }
          if (isResultMarker(marker.name)) {
            // The outcome of a call that already has a row. Folded into that
            // row wherever it is, never rendered as a row of its own — a
            // `result` row would read as a tool named "result", and the
            // marker exists to keep raw JSON out of the transcript.
            const call = marker.toolUseId ? awaitingResult.get(marker.toolUseId) : undefined
            const result = parseResultPayload(marker.args)
            if (call && result) {
              call.result = result
              awaitingResult.delete(marker.toolUseId!)
            }
            continue
          }
          const external: ExternalToolBlock = {
            type: 'externalTool',
            index: block.index,
            name: marker.name,
            args: marker.args,
            toolUseId: marker.toolUseId,
          }
          if (marker.toolUseId) awaitingResult.set(marker.toolUseId, external)
          pushStep({
            itemId: item.id,
            block: external,
            streaming: item.streaming,
            isLastInItem,
          })
          continue
        }
        rows.push({ kind: 'text', id: `${item.id}-t${block.index}`, item, block, isLastInItem })
      } else {
        // Encrypted thinking (signature, no plaintext) reaches pi as a
        // thinking block with no text. The provider extension stopped
        // emitting these, but sessions recorded before that fix are on
        // disk forever — and an empty thought renders as a card that
        // expands to nothing, and inflates the "N thoughts" count.
        // A streaming block is legitimately empty for a few frames.
        if (block.type === 'thinking' && !item.streaming && block.text.trim() === '') {
          continue
        }
        pushStep({ itemId: item.id, block, streaming: item.streaming, isLastInItem })
      }
    }

    // An empty streaming turn still needs a row to hang the spinner on.
    if (item.blocks.length === 0 && item.streaming) {
      rows.push({ kind: 'item', id: item.id, item })
    }

    // Errors and aborts belong to their message, after its content.
    if (item.stopReason === 'error' || item.stopReason === 'aborted') {
      rows.push({ kind: 'outcome', id: `${item.id}-out`, item })
    }
  }

  return rows
}

/**
 * The activity row currently receiving the agent's work.
 *
 * A tool can settle before pi starts the next assistant message, so individual
 * tool status is not a reliable lifetime for the expanded group. Keep the
 * newest activity row active across those gaps, but stop as soon as prose is
 * emitted after it so the group can collapse ahead of the answer.
 */
export function activeActivityId(rows: TranscriptRow[], isStreaming: boolean): string | null {
  if (!isStreaming) return null
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row?.kind === 'text' || row?.kind === 'outcome') return null
    if (row?.kind === 'item' && row.item.kind !== 'assistant') return null
    if (row?.kind === 'activity') return row.id
  }
  return null
}

/**
 * Sub-agents in the transcript's trailing assistant run — everything after
 * the last user message — that never reached a terminal state.
 *
 * Evidence, not assumption. Until `pi-claude-cli` 0.4.14 the CLI was killed
 * at the turn's first `result`, so a background agent always died unreported
 * and every launch belonged in this count. Now agents normally finish and the
 * count is zero — but an older provider is still installed on plenty of
 * machines and Phosphor pins nothing, so the same session can produce either
 * shape. Counting what the markers actually show keeps the strip honest under
 * both, with no version check anywhere in the renderer.
 */
export function trailingUnfinishedAgents(rows: TranscriptRow[]): number {
  let count = 0
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row?.kind === 'item' && row.item.kind === 'user') break
    if (row?.kind !== 'activity') continue
    for (const step of row.steps) {
      if (step.block.type === 'subagent' && !isTerminalAgentStatus(step.block.status)) count++
    }
  }
  return count
}

/** True while any step in the group is still producing output. */
export function isActivityLive(steps: ActivityStep[], tools: Record<string, ToolState>): boolean {
  return steps.some((s) => {
    if (s.block.type === 'externalTool') {
      // A tagged call with no result yet is a CLI-side tool still running —
      // but only while its message streams. Once the turn is settled an
      // unanswered call means the CLI never reported (it died, or the host
      // has result forwarding off), and a group that stays open forever is
      // worse than a row that stops spinning.
      return s.streaming && !!s.block.toolUseId && !s.block.result
    }
    // A running sub-agent IS live work, and the group must stay open while it
    // is out there — that is the whole difference 0.4.14 made.
    if (s.block.type === 'subagent') return !isTerminalAgentStatus(s.block.status)
    if (s.block.type === 'thinking') {
      return s.streaming && s.isLastInItem && !s.block.closed
    }
    const status = tools[s.block.toolCallId]?.status
    return status === 'starting' || status === 'running'
  })
}

export interface ActivitySummary {
  /** "9 steps" */
  stepLabel: string
  /** "edited 5 files, ran 2 commands" */
  detail: string
  thinkingCount: number
  failedCount: number
}

const NOUNS: Record<string, [string, string]> = {
  Ran: ['command', 'commands'],
  Edited: ['file', 'files'],
  Wrote: ['file', 'files'],
  Read: ['file', 'files'],
  Searched: ['pattern', 'patterns'],
  Found: ['pattern', 'patterns'],
  Listed: ['directory', 'directories'],
  Created: ['artifact', 'artifacts'],
  Updated: ['artifact', 'artifacts'],
  'Claude Code': ['tool', 'tools'],
  Launched: ['agent', 'agents'],
}

/**
 * Collapsed-head summary: "9 steps · edited 5 files, ran 2 commands".
 *
 * Counts by verb rather than listing every call — a run of 18 reads must not
 * produce an 18-item string. Verb order follows first appearance so the
 * summary still reflects what happened first.
 */
export function summarizeActivity(
  steps: ActivityStep[],
  tools: Record<string, ToolState>,
  labelFor: (tool: ToolState) => string,
): ActivitySummary {
  const order: string[] = []
  const counts = new Map<string, number>()
  let thinkingCount = 0
  let failedCount = 0

  for (const step of steps) {
    if (step.block.type === 'thinking') {
      thinkingCount++
      continue
    }
    if (step.block.type === 'subagent') {
      // Sub-agents summarize as "launched N agents", not as anonymous
      // "claude code N tools" — they are the headline of a turn.
      if (!counts.has('Launched')) order.push('Launched')
      counts.set('Launched', (counts.get('Launched') ?? 0) + 1)
      continue
    }
    if (step.block.type === 'externalTool') {
      // A CLI-side failure counts in the head like a pi tool failure. It
      // could not before: the marker carried no outcome, so a turn where
      // three commands failed inside the CLI collapsed to a clean summary.
      if (step.block.result?.status === 'error') failedCount++
      if (!counts.has('Claude Code')) order.push('Claude Code')
      counts.set('Claude Code', (counts.get('Claude Code') ?? 0) + 1)
      continue
    }
    const tool = tools[step.block.toolCallId]
    if (!tool) continue
    if (tool.status === 'error') failedCount++
    const label = labelFor(tool)
    if (!counts.has(label)) order.push(label)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  const detail = order
    .map((label) => {
      const n = counts.get(label) ?? 0
      const [one, many] = NOUNS[label] ?? ['tool', 'tools']
      return `${label.toLowerCase()} ${n} ${n === 1 ? one : many}`
    })
    .join(', ')

  const n = steps.length
  return {
    stepLabel: `${n} step${n === 1 ? '' : 's'}`,
    detail,
    thinkingCount,
    failedCount,
  }
}
