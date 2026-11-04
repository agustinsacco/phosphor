/**
 * The pi-subagents fleet, as its `subagent-async` widget reports it: one line
 * of `PI_SUBAGENT_ASYNC_JSON:` with the tree of background runs, which
 * pi-subagents documents as its host protocol for RPC clients.
 *
 * This is the one home for that parser. The renderer reads it (through
 * `@/features/chat/subagentRuns`) for the sub-agent chip, panel and sidebar;
 * the Host's lane projection (`@phosphor/host-client/projection`) reads it so
 * a lane whose parent run settled still counts as working while delegated
 * agents run. Every reader is defensive and degrades rather than throws: a
 * payload this side does not understand renders as nothing, never as an
 * invented state.
 */

export const SUBAGENT_ASYNC_WIDGET_KEY = 'subagent-async'

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
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

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
  /** Step nodes: the model the child runs on, with its thinking level as a suffix. */
  model?: string
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
  const model = str(node?.model)
  const thinking = str(node?.thinking)
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
    // pi-subagents reports the resolved model and its thinking level apart.
    model: model && thinking && !model.endsWith(`:${thinking}`) ? `${model}:${thinking}` : model,
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
