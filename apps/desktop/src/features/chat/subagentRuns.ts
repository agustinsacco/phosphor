/**
 * pi-subagents, as it reaches Phosphor over pi's RPC.
 *
 * Both providers delegate through the same extension: pi owns the tools on a
 * Claude session too (provider ≥ 0.9.0), so the `[Claude Code · Agent …]`
 * markers are history and this is the live sub-agent path for every session.
 * Four channels carry it, none of them typed on this side of the repo
 * boundary:
 *
 *  - the `subagent` tool call: a launch (an agent and a task, or a workflow
 *    script) or a management action (list, status, stop, steer, guide);
 *  - its `details`, streamed on `tool_execution_update` for a foreground run
 *    (`progress[]`: current tool, recent tools, tokens) and final on
 *    `tool_execution_end` (`results[]`: output, usage, session file);
 *  - the `subagent-async` widget, one line of `PI_SUBAGENT_ASYNC_JSON:` with
 *    the tree of background runs, which pi-subagents documents as its host
 *    protocol for RPC clients. Unparsed, the whole blob was printed above the
 *    composer;
 *  - a `subagent-notify` custom message when a background run reports back,
 *    `display: false` when it simply succeeded, so a reply that quoted the
 *    result appeared with no visible cause.
 *
 * Every reader here is defensive and degrades rather than throws: a payload
 * this side does not understand renders as the generic tool row it always
 * did, never as an invented state.
 */

export const SUBAGENT_TOOL = 'subagent'
export const SUBAGENTS_ENABLE_TOOL = 'subagents_enable'
export const SUBAGENT_ASYNC_WIDGET_KEY = 'subagent-async'
/** Replies to `/subagents-inspect-rpc`, correlated by request id. Never rendered. */
export const SUBAGENT_INSPECT_WIDGET_KEY = 'subagent-inspect'
export const SUBAGENT_NOTIFY_TYPE = 'subagent-notify'
export const SUBAGENT_CHILD_NOTIFY_TYPE = 'subagent-incremental-child-notify'
export const SUBAGENT_CONTROL_NOTICE_TYPE = 'subagent_control_notice'
export const SUBAGENT_STEERING_NOTICE_TYPE = 'subagent_steering_notice'
export const SUBAGENT_SUPERVISOR_REQUEST_TYPE = 'subagent_supervisor_request'
export const SUBAGENT_SUPERVISOR_REPLY_TYPE = 'subagent_supervisor_reply'
export const SUBAGENT_SLASH_RESULT_TYPE = 'subagent-slash-result'

const ASYNC_WIDGET_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:'
const ASYNC_SNAPSHOT_KIND = 'pi-subagents.async-status-snapshot'

type Rec = Record<string, unknown>
const rec = (value: unknown): Rec | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export function isSubagentNotice(customType: string | undefined): boolean {
  return (
    customType === SUBAGENT_NOTIFY_TYPE ||
    customType === SUBAGENT_CHILD_NOTIFY_TYPE ||
    customType === SUBAGENT_CONTROL_NOTICE_TYPE ||
    customType === SUBAGENT_STEERING_NOTICE_TYPE ||
    customType === SUBAGENT_SUPERVISOR_REQUEST_TYPE ||
    customType === SUBAGENT_SUPERVISOR_REPLY_TYPE ||
    customType === SUBAGENT_SLASH_RESULT_TYPE
  )
}

// ---------- the call ----------

export type SubagentCall =
  | {
      kind: 'launch'
      agent?: string
      task?: string
      /** Detached: the tool returns at once and the run reports back later. */
      async: boolean
      /** Legacy inline script or script path, preserved for old transcripts. */
      script?: string
      /** A named workflow resource. */
      workflow?: string
      /** `tasks` (parallel) or `chain` entries, by the native step index. */
      tasks?: { agent?: string; task?: string }[]
    }
  | { kind: 'manage'; action: string; target?: string; topic?: string }

export function subagentCall(args: Rec | undefined): SubagentCall {
  const action = str(args?.action)
  if (action) {
    return {
      kind: 'manage',
      action,
      target: str(args?.id) ?? str(args?.agent),
      topic: str(args?.topic),
    }
  }
  const entries = list(args?.tasks ?? args?.chain)
  // A chain with a nested parallel group flattens into steps that no longer
  // line up with its entries, so it binds no prompt by index at all.
  const tasks = entries.some((entry) => 'parallel' in (rec(entry) ?? {}))
    ? []
    : entries.map((entry) => ({ agent: str(rec(entry)?.agent), task: str(rec(entry)?.task) }))
  return {
    kind: 'launch',
    agent: str(args?.agent),
    task: str(args?.task),
    async: args?.async === true,
    script: str(args?.workflowScript) ?? str(args?.workflowScriptPath),
    workflow: args?.workflow === true ? 'inline workflow' : str(args?.workflow),
    ...(tasks.length ? { tasks } : {}),
  }
}

/** The agents a workflow script names, in order of first mention. */
export function scriptAgents(script: string): string[] {
  const seen: string[] = []
  for (const match of script.matchAll(/agent:\s*["']([A-Za-z0-9._-]+)["']/g)) {
    const agent = match[1]!
    if (!seen.includes(agent)) seen.push(agent)
  }
  return seen
}

// ---------- the run ----------

export type SubagentChildStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'detached' | 'paused' | 'unknown'

export interface SubagentChild {
  index: number
  agent: string
  /** The launcher's session name minus the agent prefix, when it derived one. */
  label?: string
  status: SubagentChildStatus
  model?: string
  /** "read src/auth.ts": the tool running right now, while the child runs. */
  currentTool?: string
  recentTools: string[]
  recentOutput: string[]
  toolCount?: number
  turnCount?: number
  tokens?: number
  costUsd?: number
  durationMs?: number
  error?: string
  /** The child's final answer. pi-subagents redacts the task; the call carries it. */
  output?: string
  sessionFile?: string
  outputPath?: string
}

export interface SubagentAgentInfo {
  name: string
  description?: string
  source?: string
  model?: string
  available: boolean
  unavailableReason?: string
}

export interface SubagentRun {
  mode: string
  runId?: string
  /** Detached: no children here, the fleet widget and a completion carry it. */
  async: boolean
  timeoutMs?: number
  children: SubagentChild[]
  /** From `action: "list"`. */
  agents?: SubagentAgentInfo[]
  totalTokens?: number
  totalCostUsd?: number
}

const CHILD_STATUSES = new Set<SubagentChildStatus>([
  'pending',
  'running',
  'completed',
  'failed',
  'stopped',
  'detached',
  'paused',
  'unknown',
])

/**
 * A child's state, from the two records that describe it. While the tool
 * streams the result row is a work in progress (its exit code is not set
 * yet), so the progress record decides; once the tool settled the result is
 * the verdict.
 */
function childStatus(result: Rec | undefined, progress: Rec | undefined, settled: boolean) {
  const reported = str(progress?.status) as SubagentChildStatus | undefined
  if (settled && result) {
    if (result.stopped === true) return 'stopped'
    if (result.detached === true) return 'detached'
    if (str(result.error)) return 'failed'
    const exit = num(result.exitCode)
    if (exit !== undefined) return exit === 0 ? 'completed' : 'failed'
  }
  if (reported && CHILD_STATUSES.has(reported)) return reported
  // A settled parent tool is not evidence of a successful child.
  return settled ? 'unknown' : 'running'
}

function childFrom(
  index: number,
  result: Rec | undefined,
  progress: Rec | undefined,
  settled: boolean,
): SubagentChild {
  const agent = str(result?.agent) ?? str(progress?.agent) ?? 'agent'
  const sessionName = str(result?.sessionName) ?? str(progress?.sessionName)
  const label = sessionName?.startsWith(`${agent}: `)
    ? sessionName.slice(agent.length + 2)
    : sessionName
  const usage = rec(result?.usage)
  const usageTokens =
    usage && (num(usage.input) !== undefined || num(usage.output) !== undefined)
      ? (num(usage.input) ?? 0) + (num(usage.output) ?? 0)
      : undefined
  const cost = num(usage?.cost) ?? num(rec(result?.totalCost)?.costUsd)
  const currentTool = str(progress?.currentTool)
  const currentToolArgs = str(progress?.currentToolArgs)
  const artifacts = rec(result?.artifactPaths)
  return {
    index,
    agent,
    label: label || undefined,
    status: childStatus(result, progress, settled),
    model: str(result?.model) ?? str(progress?.model),
    currentTool: currentTool
      ? currentToolArgs
        ? `${currentTool} ${currentToolArgs}`
        : currentTool
      : undefined,
    recentTools: list(progress?.recentTools)
      .map((entry) => {
        const tool = rec(entry)
        const name = str(tool?.tool)
        const args = str(tool?.args)
        return name ? (args ? `${name} ${args}` : name) : undefined
      })
      .filter((line): line is string => !!line)
      .slice(-3),
    recentOutput: list(progress?.recentOutput)
      .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
      .slice(-2),
    toolCount: num(progress?.toolCount),
    turnCount: num(progress?.turnCount) ?? num(usage?.turns),
    tokens: num(progress?.tokens) ?? usageTokens,
    costUsd: cost && cost > 0 ? cost : undefined,
    durationMs: num(progress?.durationMs),
    error: str(result?.error),
    output: str(result?.finalOutput),
    sessionFile: str(result?.sessionFile),
    outputPath: str(result?.savedOutputPath) ?? str(artifacts?.outputPath),
  }
}

function agentInfoFrom(entry: unknown): SubagentAgentInfo | undefined {
  const agent = rec(entry)
  const name = str(agent?.name)
  if (!name) return undefined
  const runner = rec(agent?.runner)
  return {
    name,
    description: str(agent?.description),
    source: str(agent?.source),
    model: str(rec(agent?.model)?.value),
    available: runner?.available !== false && agent?.executable !== false,
    unavailableReason: str(runner?.unavailableReason),
  }
}

/**
 * Read a `subagent` tool's `details`, partial or final. `results[]` and
 * `progress[]` describe the same children and are joined on their `index`, a
 * launch-order id pi-subagents keeps stable across snapshots; a record with
 * no index falls back to its position.
 */
export function subagentRun(details: unknown, settled: boolean): SubagentRun | null {
  const d = rec(details)
  if (!d) return null
  const byIndex = new Map<number, { result?: Rec; progress?: Rec }>()
  list(d.results).forEach((entry, position) => {
    const result = rec(entry)
    if (!result) return
    const index = num(result.index) ?? position
    byIndex.set(index, { ...byIndex.get(index), result })
  })
  list(d.progress).forEach((entry, position) => {
    const progress = rec(entry)
    if (!progress) return
    const index = num(progress.index) ?? position
    byIndex.set(index, { ...byIndex.get(index), progress })
  })
  const children = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, { result, progress }]) => childFrom(index, result, progress, settled))

  const agents = list(rec(d.agentCapabilities)?.agents)
    .map(agentInfoFrom)
    .filter((agent): agent is SubagentAgentInfo => !!agent)
  const totalUsage = rec(d.totalChildUsage)
  const totalTokens =
    totalUsage && num(totalUsage.input) !== undefined
      ? (num(totalUsage.input) ?? 0) + (num(totalUsage.output) ?? 0)
      : undefined
  return {
    mode: str(d.mode) ?? 'single',
    runId: str(d.runId) ?? str(d.asyncId),
    async: d.background === true || (str(d.asyncId) !== undefined && children.length === 0),
    timeoutMs: num(d.timeoutMs),
    children,
    agents: agents.length > 0 ? agents : undefined,
    totalTokens,
    totalCostUsd: num(rec(d.totalCost)?.costUsd),
  }
}

/**
 * How many agents one launch started. A `parallel` call names one task per
 * child and its details report one record per child, so one call can be four
 * agents. A launch nothing describes yet (detached, a script not started)
 * counts as one.
 */
export function launchedAgentCount(args: unknown, details: unknown): number {
  const reported = subagentRun(details, false)?.children.length ?? 0
  return Math.max(reported, list(rec(args)?.tasks).length, 1)
}

// ---------- the row ----------

export interface SubagentRowSummary {
  label: string
  object?: string
  hint?: string
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

function childStats(child: SubagentChild): string | undefined {
  const parts = [
    child.toolCount === undefined ? undefined : plural(child.toolCount, 'tool'),
    child.tokens === undefined ? undefined : `${formatTokensShort(child.tokens)} tokens`,
    child.durationMs === undefined ? undefined : formatDurationShort(child.durationMs),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** `formatTokens` from `@/lib/format`, inlined so this module stays dependency-free. */
function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

const MANAGE_VERBS: Record<string, [running: string, done: string, object?: string]> = {
  list: ['Listing', 'Listed', 'agents'],
  status: ['Checking on', 'Checked on', 'agents'],
  stop: ['Stopping', 'Stopped'],
  steer: ['Steering', 'Steered'],
  resume: ['Resuming', 'Resumed'],
  guide: ['Reading the guide on', 'Read the guide on', 'sub-agents'],
  validate: ['Validating', 'Validated', 'workflow'],
}

/**
 * What the collapsed row says, in the same vocabulary as pi's own tools: the
 * verb is what the model did, the object is who, and the hint is what it is
 * costing right now or what it cost.
 */
export function summarizeSubagentCall(
  call: SubagentCall,
  run: SubagentRun | null,
  running: boolean,
): SubagentRowSummary {
  if (call.kind === 'manage') {
    const verb = MANAGE_VERBS[call.action]
    if (!verb) return { label: running ? 'Using' : 'Used', object: `subagent ${call.action}` }
    const target = call.action === 'guide' ? call.topic : call.target
    const object = target ? shortId(target) : verb[2]
    return { label: running ? verb[0] : verb[1], object }
  }

  const children = run?.children ?? []
  const done = children.filter((child) =>
    ['completed', 'failed', 'stopped', 'paused'].includes(child.status),
  ).length

  if (call.async || run?.async) {
    return {
      label: running ? 'Starting' : 'Started',
      object: call.agent ?? call.workflow ?? 'agents',
      hint: 'in background',
    }
  }

  if (call.script || call.workflow || (run && run.mode !== 'single')) {
    const agents =
      children.length > 0
        ? [...new Set(children.map((child) => child.agent))]
        : call.script
          ? scriptAgents(call.script)
          : []
    const object =
      call.workflow ?? (agents.length > 0 ? agents.join(' · ') : (call.agent ?? 'workflow'))
    return {
      label: running ? 'Running workflow' : 'Ran workflow',
      object,
      hint:
        children.length > 0
          ? running
            ? `${done}/${children.length} done`
            : plural(children.length, 'agent')
          : undefined,
    }
  }

  const child = children[0]
  const hint = running
    ? [
        child?.currentTool,
        child?.toolCount === undefined ? undefined : plural(child.toolCount, 'tool'),
      ]
        .filter(Boolean)
        .join(' · ') || undefined
    : child
      ? childStats(child)
      : undefined
  return {
    label: running ? 'Delegating to' : 'Delegated to',
    object: call.agent ?? child?.agent ?? 'an agent',
    hint,
  }
}

export function isChildLive(child: SubagentChild): boolean {
  return child.status === 'running' || child.status === 'pending'
}

/** A run id is a UUID; eight characters tell it apart in a row. */
export function shortId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id
}

// ---------- the fleet ----------

export type FleetState =
  'queued' | 'running' | 'complete' | 'failed' | 'partial' | 'paused' | 'stopped' | 'rejected'

export interface FleetNode {
  id: string
  /** `subagent`, `workflow`, `step`, `host-step`. */
  kind: string
  /** The agent, a workflow label, or a step's agent. */
  label: string
  state: FleetState
  startedAt?: number
  endedAt?: number
  currentTool?: string
  currentToolStartedAt?: number
  lastActivityAt?: number
  toolCount?: number
  turnCount?: number
  /** pi-subagents' watchdog flagged it (`needs_attention`). */
  attention: boolean
  children: FleetNode[]
}

export interface FleetSnapshot {
  generatedAt: number
  runs: FleetNode[]
  /** Runs the extension left out to stay within its byte budget. */
  omittedRuns: number
  incomplete: boolean
  /** Active roots, including roots whose descendants are still active. Not a child count. */
  active: number
}

const FLEET_STATES = new Set<FleetState>([
  'queued',
  'running',
  'complete',
  'failed',
  'partial',
  'paused',
  'stopped',
  'rejected',
])

export function isFleetActive(state: FleetState): boolean {
  return state === 'running' || state === 'queued'
}

function fleetNode(
  entry: unknown,
  depth: number,
  budget: { remaining: number; incomplete: boolean },
): FleetNode | undefined {
  if (budget.remaining-- <= 0) {
    budget.incomplete = true
    return undefined
  }
  const node = rec(entry)
  const id = str(node?.id)
  const state = str(node?.state) as FleetState | undefined
  if (!id || !state || !FLEET_STATES.has(state)) {
    budget.incomplete = true
    return undefined
  }
  if (depth === 4 && list(node?.children).length) budget.incomplete = true
  const activity = rec(node?.activity)
  return {
    id,
    kind: str(node?.kind) ?? 'subagent',
    label: str(node?.label) ?? 'agent',
    state,
    startedAt: num(node?.startedAt),
    endedAt: num(node?.endedAt),
    currentTool: str(activity?.currentTool),
    currentToolStartedAt: num(activity?.currentToolStartedAt),
    lastActivityAt: num(activity?.lastActivityAt),
    toolCount: num(activity?.toolCount),
    turnCount: num(activity?.turnCount),
    attention: activity?.state === 'needs_attention',
    // The extension caps depth at 3; one more here costs nothing and never
    // recurses on a malicious payload.
    children:
      depth < 4
        ? list(node?.children)
            .map((child) => fleetNode(child, depth + 1, budget))
            .filter((child): child is FleetNode => !!child)
        : [],
  }
}

/**
 * The `subagent-async` widget: exactly one line, `PI_SUBAGENT_ASYNC_JSON:`
 * followed by a versioned snapshot. The kind and version are checked so a
 * future shape renders nothing rather than something wrong.
 */
export function parseFleetWidget(lines: string[] | undefined): FleetSnapshot | null {
  const line = lines?.[0]
  if (!line?.startsWith(ASYNC_WIDGET_PREFIX) || line.length > 128_000) return null
  let raw: unknown
  try {
    raw = JSON.parse(line.slice(ASYNC_WIDGET_PREFIX.length))
  } catch {
    return null
  }
  const snapshot = rec(raw)
  if (!snapshot || snapshot.kind !== ASYNC_SNAPSHOT_KIND || snapshot.version !== 1) return null
  const budget = { remaining: 200, incomplete: false }
  const runs = list(snapshot.runs)
    .map((run) => fleetNode(run, 0, budget))
    .filter((run): run is FleetNode => !!run)
  return {
    generatedAt: num(snapshot.generatedAt) ?? 0,
    runs,
    omittedRuns: num(rec(snapshot.omitted)?.runs) ?? 0,
    incomplete:
      budget.incomplete ||
      (num(rec(snapshot.omitted)?.runs) ?? 0) > 0 ||
      (num(rec(snapshot.omitted)?.children) ?? 0) > 0 ||
      rec(snapshot.omitted)?.byteLimitExceeded === true,
    active: runs.filter(fleetNodeActive).length,
  }
}

function fleetNodeActive(node: FleetNode): boolean {
  return isFleetActive(node.state) || node.children.some(fleetNodeActive)
}

/** Omitted nodes prevent a live snapshot from proving delegated work is settled. */
export function hasDelegatedWork(lines: string[] | undefined): boolean {
  const snapshot = parseFleetWidget(lines)
  return !!snapshot && (snapshot.active > 0 || snapshot.incomplete)
}

/** The tool a running node is on: its own, else the first running child's. */
export function fleetCurrentTool(node: FleetNode): string | undefined {
  if (node.currentTool) return node.currentTool
  for (const child of node.children) {
    if (!fleetNodeActive(child)) continue
    const tool = fleetCurrentTool(child)
    if (tool) return tool
  }
  return undefined
}

/** "1 background agent running · scout · grep" — one line for the strip. */
export function summarizeFleet(snapshot: FleetSnapshot): string {
  if (snapshot.active === 0)
    return snapshot.incomplete ? 'Background snapshot incomplete' : 'No background runs active'
  const label = `${plural(snapshot.active, 'background run')} active`
  const newest = snapshot.runs.filter(fleetNodeActive).at(-1)
  if (!newest) return label
  const tool = fleetCurrentTool(newest)
  return [label, newest.label, tool].filter(Boolean).join(' · ')
}

// ---------- the completion ----------

export interface SubagentNotice {
  kind: 'completion' | 'attention' | 'steering' | 'question' | 'reply'
  runId?: string
  /**
   * Every run a completion reports, from its structured `details.runs`
   * (native IDs only). `runId` is set only when there is exactly one.
   */
  runs?: { runId: string; agent?: string }[]
  workflowRunId?: string
  /** Compact native signal; the full diagnostic stays in body. */
  summary?: string
  requestId?: string
  childIndex?: number
  status?: 'completed' | 'failed' | 'stopped' | 'paused'
  agents: string[]
  /** "scout finished in the background" */
  headline: string
  /** Markdown: the child's output and pi-subagents' correlation lines. */
  body: string
}

const COMPLETION_HEADER =
  /^(Background|Detached foreground) tasks? (completed|failed|stopped|paused)(?: \((\d+)\))?: (.*)$/

const STATUS_VERB: Record<NonNullable<SubagentNotice['status']>, string> = {
  completed: 'finished',
  failed: 'failed',
  stopped: 'was stopped',
  paused: 'paused',
}

/**
 * Read a pi-subagents notice. The completion's first line is
 * `Background task completed: **scout**`; the rest is the child's output. The
 * two notice types carry prose the extension already wrote for a human.
 */
export function parseSubagentNotice(
  customType: string | undefined,
  text: string,
  details?: unknown,
): SubagentNotice | null {
  if (!isSubagentNotice(customType)) return null
  if (
    customType === SUBAGENT_SUPERVISOR_REQUEST_TYPE ||
    customType === SUBAGENT_SUPERVISOR_REPLY_TYPE
  ) {
    const d = rec(details)
    const agent = str(d?.agent)
    const reply = customType === SUBAGENT_SUPERVISOR_REPLY_TYPE
    return {
      kind: reply ? 'reply' : 'question',
      agents: agent ? [agent] : [],
      headline: reply
        ? `Parent replied to ${agent ?? 'a sub-agent'}`
        : `${agent ?? 'A sub-agent'} asked the parent for guidance`,
      body: reply ? (str(d?.message) ?? text) : (str(d?.requestBody) ?? text),
      runId: str(d?.runId),
      requestId: str(d?.requestId) ?? str(d?.id),
      childIndex: num(d?.childIndex),
    }
  }
  const trimmed = text.trim()
  const newline = trimmed.indexOf('\n')
  const first = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim()
  const rest = newline === -1 ? '' : trimmed.slice(newline + 1).trim()
  const plain = first.replace(/\*\*/g, '')

  if (customType === SUBAGENT_CHILD_NOTIFY_TYPE) {
    // 0.76.1 has no details on this notice. Read only its explicit correlation
    // lines, never infer identity from the profile name or an artifact path.
    const id = (label: string): string | undefined =>
      new RegExp(`^${label}: ([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$`, 'mi').exec(
        trimmed,
      )?.[1]
    const match = /^Workflow child completed: \*\*([^*]+)\*\*$/.exec(first)
    return {
      kind: 'completion',
      ...(match ? { status: 'completed' as const } : {}),
      agents: match ? [match[1]!] : [],
      headline: match ? `${match[1]} completed a workflow step` : plain,
      summary: match
        ? `${/^Status: workflow still running$/m.test(rest) ? 'Workflow was still running at this update. ' : ''}Execution completion is not acceptance.`
        : undefined,
      runId: id('Child run'),
      workflowRunId: id('Workflow run'),
      body: rest,
    }
  }
  const event = rec(rec(details)?.event)
  if (customType === SUBAGENT_CONTROL_NOTICE_TYPE && event?.type === 'needs_attention') {
    const agent = str(event.agent) ?? 'A sub-agent'
    const key = str(event.workflowKey)
    const signal = str(event.message)
    return {
      kind: 'attention',
      agents: [agent],
      headline: `${key && key !== agent ? `${key} · ` : ''}${agent} needs parent attention`,
      runId: str(event.runId),
      childIndex: num(event.index),
      summary: signal
        ? `${signal}${event.reason === 'tool_open_threshold' ? '. Elapsed time alone does not prove a stall.' : ''}`
        : undefined,
      body: text,
    }
  }
  if (customType !== SUBAGENT_NOTIFY_TYPE) {
    return {
      kind: customType === SUBAGENT_STEERING_NOTICE_TYPE ? 'steering' : 'attention',
      agents: [],
      headline: plain,
      body: rest,
    }
  }
  // Current pi-subagents names each reported run in `details.runs`; older
  // notices have no details. Never read a run ID out of the prose or a path.
  const runs = list(rec(details)?.runs).flatMap((entry) => {
    const runId = str(rec(entry)?.runId)
    return runId ? [{ runId, agent: str(rec(entry)?.agent) }] : []
  })
  const identity = runs.length
    ? { runs, ...(runs.length === 1 ? { runId: runs[0]!.runId } : {}) }
    : {}
  const match = COMPLETION_HEADER.exec(first)
  if (!match) return { kind: 'completion', agents: [], headline: plain, body: rest, ...identity }
  const status = match[2] as NonNullable<SubagentNotice['status']>
  const agents = [...match[4]!.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!.trim())
  const who = agents.length > 0 ? agents.join(', ') : 'A sub-agent'
  const where = match[1] === 'Background' ? 'in the background' : 'after detaching'
  return {
    kind: 'completion',
    status,
    agents,
    headline: `${who} ${STATUS_VERB[status]} ${where}`,
    body: rest,
    ...identity,
  }
}
