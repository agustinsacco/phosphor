/**
 * Live sub-agent state, as published by the Claude Code provider
 * (`@saccolabs/pi-claude-cli` ≥ 0.4.13) over pi's status channel.
 *
 * Same shape of contract as `claude-rate-limit`: state ABOUT a turn, pushed
 * out of band because folding it into the transcript would bury it. The CLI
 * emits `task_progress` once per sub-agent tool call — roughly 700 times in
 * the fan-out that motivated the channel — so this is the only place per-step
 * progress can live.
 *
 * It is a WIRE CONTRACT across a repo boundary: nothing here fails to compile
 * when the provider changes it (docs/extensions.md). So every field
 * is read defensively, and a payload that parses to nothing renders nothing.
 *
 * The key must also stay in `STRUCTURED_STATUS_KEYS`. Until it did, the raw
 * JSON was printed verbatim along the bottom of the window — the
 * `…,"status":"running","currentStep":"Running Read stream-parser…"` line a
 * user reported as garbage in the status strip.
 */
export const SUBAGENTS_STATUS_KEY = 'claude-subagents'

export interface SubagentTask {
  taskId: string
  /** Names the task; set when it started. */
  description: string
  subagentType?: string
  status: string
  /** The step running right now, cleared when the task ends. */
  currentStep?: string
  /**
   * The last tool the agent invoked. A coarser fact than `currentStep` and it
   * outlives it: the provider clears the step between tool calls but leaves
   * this set, so it is the fallback that keeps a row from going blank
   * mid-flight.
   */
  lastToolName?: string
  toolUses?: number
  totalTokens?: number
  durationMs?: number
}

export interface SubagentSnapshot {
  tasks: SubagentTask[]
  /** Agents still working. */
  active: number
  /** Agents that reached any terminal state. */
  completed: number
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export function parseSubagentStatus(statusText: string | undefined): SubagentSnapshot | null {
  if (!statusText) return null
  let raw: unknown
  try {
    raw = JSON.parse(statusText)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const rawTasks = (raw as { tasks?: unknown }).tasks
  if (!Array.isArray(rawTasks)) return null

  const tasks: SubagentTask[] = []
  for (const entry of rawTasks) {
    if (!entry || typeof entry !== 'object') continue
    const task = entry as Record<string, unknown>
    const taskId = str(task.taskId)
    if (!taskId) continue
    tasks.push({
      taskId,
      description: str(task.description) ?? '',
      subagentType: str(task.subagentType),
      status: str(task.status) ?? 'running',
      currentStep: str(task.currentStep),
      lastToolName: str(task.lastToolName),
      toolUses: num(task.toolUses),
      totalTokens: num(task.totalTokens),
      durationMs: num(task.durationMs),
    })
  }
  if (tasks.length === 0) return null

  // The provider sends its own counts, but they are derivable and this side
  // renders them — so recompute rather than trusting two sources to agree.
  const active = tasks.filter((task) => task.status === 'running').length
  return { tasks, active, completed: tasks.length - active }
}

/**
 * One agent's live state, for the transcript row that already knows its id.
 *
 * The transcript rows are fed by MARKERS, and a sub-agent produces exactly two
 * of those — `task_started` and its terminal notification. Between them the row
 * cannot change, which is why an eight-agent fan-out rendered as eight
 * identical "running" lines for as long as it ran. The live step for every one
 * of those agents was already being parsed here and then discarded, because
 * `summarizeSubagents` keeps one line for the strip.
 *
 * The join is `taskId`, the CLI's own id, which both sides already carry
 * (`SubagentBlock.taskId`). Returns undefined for an agent the snapshot does
 * not mention — including every agent once the episode ends, since the
 * provider CLEARS the key then. That is deliberate: a settled row must keep
 * rendering from its markers rather than blanking when live state goes away.
 *
 * Parsing is memoized on the exact payload string because every row on screen
 * asks the same question about the same blob on the same tick.
 */
let lastText: string | undefined
let lastSnapshot: SubagentSnapshot | null = null

export function findLiveSubagent(
  statusText: string | undefined,
  taskId: string | undefined,
): SubagentTask | undefined {
  if (!statusText || !taskId) return undefined
  if (statusText !== lastText) {
    lastText = statusText
    lastSnapshot = parseSubagentStatus(statusText)
  }
  return lastSnapshot?.tasks.find((task) => task.taskId === taskId)
}

/** "3 agents · Running Read stream-parser.ts" — one line for the strip. */
export function summarizeSubagents(snapshot: SubagentSnapshot): string {
  const { tasks, active } = snapshot
  const label =
    active > 0
      ? `${active} agent${active === 1 ? '' : 's'} running`
      : `${tasks.length} agent${tasks.length === 1 ? '' : 's'} done`
  // One current step, not all of them: the strip is a single line, and the
  // newest running agent is the one the user is waiting on.
  const step = tasks.filter((task) => task.status === 'running').at(-1)?.currentStep
  return step ? `${label} · ${step}` : label
}
