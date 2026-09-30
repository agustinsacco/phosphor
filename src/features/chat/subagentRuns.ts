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
 * omp does not run pi-subagents: it delegates through its own `task` tool and
 * reports on the subagents in frames of its own. The last section maps those
 * onto the same run and child model, so one row and one set of cards serve
 * both agents.
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
export const SUBAGENT_CONTROL_NOTICE_TYPE = 'subagent_control_notice'
export const SUBAGENT_STEERING_NOTICE_TYPE = 'subagent_steering_notice'

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
    customType === SUBAGENT_CONTROL_NOTICE_TYPE ||
    customType === SUBAGENT_STEERING_NOTICE_TYPE
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
      /** A `workflowScript` / `workflowScriptPath` launch. */
      script?: string
      /** A named workflow resource. */
      workflow?: string
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
  return {
    kind: 'launch',
    agent: str(args?.agent),
    task: str(args?.task),
    async: args?.async === true,
    script: str(args?.workflowScript) ?? str(args?.workflowScriptPath),
    workflow: str(args?.workflow),
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
  'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'detached'

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
  return settled ? 'completed' : 'running'
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
  const done = children.filter((child) => !isChildLive(child)).length

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

function fleetNode(entry: unknown, depth: number): FleetNode | undefined {
  const node = rec(entry)
  const id = str(node?.id)
  const state = str(node?.state) as FleetState | undefined
  if (!id || !state || !FLEET_STATES.has(state)) return undefined
  const activity = rec(node?.activity)
  return {
    id,
    kind: str(node?.kind) ?? 'subagent',
    label: str(node?.label) ?? 'agent',
    state,
    startedAt: num(node?.startedAt),
    endedAt: num(node?.endedAt),
    currentTool: str(activity?.currentTool),
    lastActivityAt: num(activity?.lastActivityAt),
    toolCount: num(activity?.toolCount),
    turnCount: num(activity?.turnCount),
    attention: activity?.state === 'needs_attention',
    // The extension caps depth at 3; one more here costs nothing and never
    // recurses on a malicious payload.
    children:
      depth < 4
        ? list(node?.children)
            .map((child) => fleetNode(child, depth + 1))
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
  if (!line?.startsWith(ASYNC_WIDGET_PREFIX)) return null
  let raw: unknown
  try {
    raw = JSON.parse(line.slice(ASYNC_WIDGET_PREFIX.length))
  } catch {
    return null
  }
  const snapshot = rec(raw)
  if (!snapshot || snapshot.kind !== ASYNC_SNAPSHOT_KIND || snapshot.version !== 1) return null
  const runs = list(snapshot.runs)
    .map((run) => fleetNode(run, 0))
    .filter((run): run is FleetNode => !!run)
  return {
    generatedAt: num(snapshot.generatedAt) ?? 0,
    runs,
    omittedRuns: num(rec(snapshot.omitted)?.runs) ?? 0,
    active: runs.filter((run) => isFleetActive(run.state)).length,
  }
}

/** The tool a running node is on: its own, else the first running child's. */
export function fleetCurrentTool(node: FleetNode): string | undefined {
  if (node.currentTool) return node.currentTool
  for (const child of node.children) {
    if (!isFleetActive(child.state)) continue
    const tool = fleetCurrentTool(child)
    if (tool) return tool
  }
  return undefined
}

/** "1 background agent running · scout · grep" — one line for the strip. */
export function summarizeFleet(snapshot: FleetSnapshot): string {
  const total = snapshot.runs.length + snapshot.omittedRuns
  if (snapshot.active === 0) return `${plural(total, 'background run')} done`
  const label = `${plural(snapshot.active, 'background agent')} running`
  const newest = snapshot.runs.filter((run) => isFleetActive(run.state)).at(-1)
  if (!newest) return label
  const tool = fleetCurrentTool(newest)
  return [label, newest.label, tool].filter(Boolean).join(' · ')
}

// ---------- the completion ----------

export interface SubagentNotice {
  kind: 'completion' | 'attention' | 'steering'
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
): SubagentNotice | null {
  if (!isSubagentNotice(customType)) return null
  const trimmed = text.trim()
  const newline = trimmed.indexOf('\n')
  const first = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim()
  const rest = newline === -1 ? '' : trimmed.slice(newline + 1).trim()
  const plain = first.replace(/\*\*/g, '')

  if (customType !== SUBAGENT_NOTIFY_TYPE) {
    return {
      kind: customType === SUBAGENT_STEERING_NOTICE_TYPE ? 'steering' : 'attention',
      agents: [],
      headline: plain,
      body: rest,
    }
  }
  const match = COMPLETION_HEADER.exec(first)
  if (!match) return { kind: 'completion', agents: [], headline: plain, body: rest }
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
  }
}

// ---------- omp's `task` ----------
//
// Three sources describe one omp subagent, joined on its id (omp's agent id,
// the batch item's `name` or a generated one):
//
//  - the call's `details` (`TaskToolDetails`, pi-tui `tools/task.ts`):
//    `progress[]` per spawn while the call streams, `results[]` once a
//    blocking call settled. A background call (`details.async`, the RPC
//    default for every agent not declared `blocking`) returns at once, with
//    the progress of that moment;
//  - `subagent_lifecycle` / `subagent_progress` frames, which the reducer
//    keeps on the call's `ToolState.subagents` (`OmpSubagentLive`);
//  - `get_subagents` when a view opens onto a running session, merged the
//    same way.
//
// A settled result is the verdict; a live frame beats the call's snapshot.

export const OMP_TASK_TOOL = 'task'

/** One subagent as omp's frames last described it. Read by `ompTaskRun`. */
export interface OmpSubagentLive {
  id: string
  index?: number
  agent?: string
  /** omp's word from the latest frame: a lifecycle `started` or a progress status. */
  status?: string
  description?: string
  sessionFile?: string
  /** A background spawn: the call returned while it ran. */
  detached?: boolean
  /** The latest `AgentProgress`, as sent. */
  progress?: unknown
}

/** omp's `TaskToolDetails`, told apart by the fields every one of them carries. */
export function isOmpTaskDetails(details: unknown): boolean {
  const d = rec(details)
  return (
    !!d &&
    Array.isArray(d.results) &&
    typeof d.totalDurationMs === 'number' &&
    'projectAgentsDir' in d
  )
}

/** What one frame or snapshot says about one subagent, and whose it is. */
export interface OmpSubagentUpdate {
  /** The `task` call that spawned it. */
  parentToolCallId: string
  /** Only the fields this record carried; the rest stay as last known. */
  live: OmpSubagentLive
}

/**
 * A `subagent_lifecycle` or `subagent_progress` frame. Null for one that
 * names no subagent or no parent call, and for `subagent_event`, which the
 * `progress` subscription never asks for.
 */
export function ompSubagentUpdate(frame: unknown): OmpSubagentUpdate | null {
  const f = rec(frame)
  const payload = rec(f?.payload)
  const parentToolCallId = str(payload?.parentToolCallId)
  if (!payload || !parentToolCallId) return null
  const progress = f?.type === 'subagent_progress' ? rec(payload.progress) : undefined
  const id = f?.type === 'subagent_lifecycle' ? str(payload.id) : str(progress?.id)
  if (!id) return null
  return {
    parentToolCallId,
    live: {
      id,
      index: num(payload.index),
      agent: str(payload.agent),
      status: str(progress ? progress.status : payload.status),
      description: str(progress ? progress.description : payload.description),
      sessionFile: str(payload.sessionFile),
      detached: payload.detached === true ? true : undefined,
      progress,
    },
  }
}

/** One `get_subagents` row: a subagent still running when the view opened. */
export function ompSnapshotUpdate(snapshot: unknown): OmpSubagentUpdate | null {
  const s = rec(snapshot)
  const parentToolCallId = str(s?.parentToolCallId)
  const id = str(s?.id)
  if (!s || !parentToolCallId || !id) return null
  return {
    parentToolCallId,
    live: {
      id,
      index: num(s.index),
      agent: str(s.agent),
      status: str(s.status),
      description: str(s.description),
      sessionFile: str(s.sessionFile),
      progress: rec(s.progress),
    },
  }
}

/** A newer record over an older one, field by field: frames restate what they carry. */
export function mergeOmpSubagent(
  known: OmpSubagentLive | undefined,
  update: OmpSubagentLive,
): OmpSubagentLive {
  return {
    id: update.id,
    index: update.index ?? known?.index,
    agent: update.agent ?? known?.agent,
    status: update.status ?? known?.status,
    description: update.description ?? known?.description,
    sessionFile: update.sessionFile ?? known?.sessionFile,
    detached: update.detached ?? known?.detached,
    progress: update.progress ?? known?.progress,
  }
}

/** A `task` call as the row's call: batch (`tasks[]`, `context`) or flat. */
export function ompTaskCall(args: Rec | undefined): SubagentCall {
  const items = list(args?.tasks)
    .map(rec)
    .filter((item): item is Rec => !!item)
  if (items.length > 0) {
    // omp's schema default when an item names no agent.
    const agents = [...new Set(items.map((item) => str(item.agent) ?? 'task'))]
    return {
      kind: 'launch',
      agent: agents.length === 1 ? agents[0] : undefined,
      task: str(args?.context),
      async: false,
    }
  }
  return { kind: 'launch', agent: str(args?.agent), task: str(args?.task), async: false }
}

const OMP_CHILD_STATUS: Record<string, SubagentChildStatus> = {
  pending: 'pending',
  started: 'running',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  aborted: 'stopped',
}

interface OmpChildSources {
  index: number
  progress?: Rec
  result?: Rec
  live?: OmpSubagentLive
}

/** The call's state, and whether this view watched it run or replayed it. */
export interface OmpTaskState {
  settled: boolean
  /**
   * The call executed while this view was open. A call replayed from the
   * session file holds, for a background spawn, only the snapshot taken when
   * it returned, which says nothing about how the spawn ended.
   */
  watched: boolean
}

function ompChildStatus(
  sources: OmpChildSources,
  background: boolean,
  state: OmpTaskState,
): SubagentChildStatus {
  const { result, live, progress } = sources
  if (result) {
    if (result.aborted === true) return 'stopped'
    if (str(result.error) || (num(result.exitCode) ?? 0) !== 0) return 'failed'
    return 'completed'
  }
  const word = str(live ? live.status : progress?.status)
  const reported =
    word && Object.hasOwn(OMP_CHILD_STATUS, word) ? OMP_CHILD_STATUS[word] : undefined
  if (live && reported) return reported
  // A snapshot with no matching live frame can only describe the moment a
  // background call returned. Once the parent settles, it cannot prove that
  // the child is still running — even when this view watched the call.
  const stale = background && state.settled && (!state.watched || !live)
  const unfinished = reported === 'pending' || reported === 'running'
  if (reported && !(stale && unfinished)) return reported
  // Ran in the background, outcome not recorded here: omp's completion card
  // (`async-result`) in the transcript is what reports it.
  if (stale) return 'detached'
  return state.settled ? 'completed' : 'running'
}

/** The subagent's final `yield`, which is its answer when no result carries one. */
function ompYieldText(progress: Rec | undefined): string | undefined {
  const last = rec(list(rec(progress?.extractedToolData)?.yield).at(-1))
  if (!last || last.status === 'aborted' || last.data === undefined || last.data === null) {
    return undefined
  }
  if (typeof last.data === 'string') return last.data.trim() || undefined
  return '```json\n' + JSON.stringify(last.data, null, 2) + '\n```'
}

function ompChild(
  id: string,
  sources: OmpChildSources,
  background: boolean,
  state: OmpTaskState,
): SubagentChild {
  const { result, live } = sources
  const progress = rec(live?.progress) ?? sources.progress
  const agent = str(result?.agent) ?? str(live?.agent) ?? str(progress?.agent) ?? 'agent'
  const label =
    str(live?.description) ?? str(result?.description) ?? str(progress?.description) ?? id
  const currentTool = str(progress?.currentTool)
  const currentToolArgs = str(progress?.currentToolArgs)
  const cost = num(rec(rec(result?.usage)?.cost)?.total) ?? num(progress?.cost)
  return {
    index: sources.index,
    agent,
    label: label === agent ? undefined : label,
    status: ompChildStatus(sources, background, state),
    model: str(result?.resolvedModel) ?? str(progress?.resolvedModel),
    currentTool: currentTool
      ? currentToolArgs
        ? `${currentTool} ${currentToolArgs}`
        : currentTool
      : undefined,
    // omp keeps both newest first; the cards read oldest to newest.
    recentTools: list(progress?.recentTools)
      .slice(0, 3)
      .reverse()
      .map((entry) => {
        const tool = rec(entry)
        const name = str(tool?.tool)
        const args = str(tool?.args)
        return name ? (args ? `${name} ${args}` : name) : undefined
      })
      .filter((line): line is string => !!line),
    recentOutput: list(progress?.recentOutput)
      .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
      .slice(0, 2)
      .reverse(),
    toolCount: num(progress?.toolCount),
    // omp counts assistant requests, one per turn.
    turnCount: num(result?.requests) ?? num(progress?.requests),
    tokens: num(result?.tokens) ?? num(progress?.tokens),
    costUsd: cost && cost > 0 ? cost : undefined,
    durationMs: num(result?.durationMs) ?? num(progress?.durationMs),
    error: str(result?.error) ?? (result?.aborted === true ? str(result.abortReason) : undefined),
    output: str(result?.output) ?? ompYieldText(progress),
    sessionFile: str(live?.sessionFile),
    outputPath: str(result?.outputPath),
  }
}

/**
 * A `task` call's subagents as one run, one child per subagent. Null when
 * neither the details are omp's nor any frame names the call: the row stays
 * the generic one.
 */
export function ompTaskRun(
  details: unknown,
  live: Record<string, OmpSubagentLive> | undefined,
  state: OmpTaskState,
): SubagentRun | null {
  const d = isOmpTaskDetails(details) ? rec(details) : undefined
  const frames = Object.values(live ?? {}).filter((entry) => str(entry?.id))
  if (!d && frames.length === 0) return null

  const byId = new Map<string, OmpChildSources>()
  const add = (id: string, index: number | undefined, patch: Partial<OmpChildSources>): void => {
    const known = byId.get(id)
    byId.set(id, { ...known, ...patch, index: known?.index ?? index ?? byId.size })
  }
  list(d?.progress).forEach((entry, position) => {
    const progress = rec(entry)
    const id = str(progress?.id)
    if (progress && id) add(id, num(progress.index) ?? position, { progress })
  })
  list(d?.results).forEach((entry, position) => {
    const result = rec(entry)
    const id = str(result?.id)
    if (result && id) add(id, num(result.index) ?? position, { result })
  })
  for (const entry of frames) add(entry.id, num(entry.index), { live: entry })

  const background = d ? rec(d.async) !== undefined : frames.some((entry) => entry.detached)
  const children = [...byId.entries()]
    .map(([id, sources]) => ompChild(id, sources, background, state))
    .sort((a, b) => a.index - b.index)
  return {
    mode: children.length > 1 ? 'parallel' : 'single',
    runId: str(rec(d?.async)?.jobId),
    // The children are here, live: the pi-subagents "reports back later" note does not apply.
    async: false,
    children,
  }
}

/**
 * The collapsed row for an omp `task` call. It stays live while any child
 * runs, which for a background call is long after the call returned.
 */
export function summarizeOmpTask(
  call: SubagentCall,
  run: SubagentRun,
  running: boolean,
): SubagentRowSummary {
  const children = run.children
  const live = running || children.some(isChildLive)
  const agents = [...new Set(children.map((child) => child.agent))]
  const object =
    agents.length > 0
      ? agents.join(' · ')
      : ((call.kind === 'launch' ? call.agent : undefined) ?? 'an agent')
  const label = live ? 'Delegating to' : 'Delegated to'
  if (children.length > 1) {
    const done = children.filter((child) => !isChildLive(child)).length
    const failed = children.filter((child) => child.status === 'failed').length
    return {
      label,
      object,
      hint: live
        ? `${done}/${children.length} done`
        : [plural(children.length, 'agent'), failed > 0 ? `${failed} failed` : undefined]
            .filter(Boolean)
            .join(' · '),
    }
  }
  const child = children[0]
  const hint = live
    ? [
        child?.currentTool,
        child?.toolCount === undefined ? undefined : plural(child.toolCount, 'tool'),
      ]
        .filter(Boolean)
        .join(' · ') || undefined
    : child
      ? childStats(child)
      : undefined
  return { label, object, hint }
}

/** Just what `ompFleet` reads of a tool call. */
export interface OmpTaskCallLike {
  toolName: string | null
  subagents?: Record<string, OmpSubagentLive>
  result?: { details?: unknown }
  output?: { details?: unknown } | null
}

/**
 * omp's background subagents that are still running, as the fleet the status
 * strip's chip summarizes, or null when none is. A background spawn is one
 * omp flagged `detached`, or one under a call that returned as a background
 * job (a `get_subagents` row carries no flag).
 */
export function ompFleet(calls: Iterable<OmpTaskCallLike>): FleetSnapshot | null {
  const runs: FleetNode[] = []
  for (const call of calls) {
    if (call.toolName !== OMP_TASK_TOOL || !call.subagents) continue
    const details = call.result?.details ?? call.output?.details
    const backgroundCall = isOmpTaskDetails(details) && rec(rec(details)?.async) !== undefined
    for (const entry of Object.values(call.subagents)) {
      const status = entry.status
      const state: FleetState | undefined =
        status === 'pending'
          ? 'queued'
          : status === 'started' || status === 'running'
            ? 'running'
            : undefined
      if (!state || !(entry.detached || backgroundCall)) continue
      const progress = rec(entry.progress)
      runs.push({
        id: entry.id,
        kind: 'subagent',
        label: entry.agent ?? 'agent',
        state,
        currentTool: str(progress?.currentTool),
        toolCount: num(progress?.toolCount),
        attention: false,
        children: [],
      })
    }
  }
  if (runs.length === 0) return null
  return { generatedAt: 0, runs, omittedRuns: 0, active: runs.length }
}
