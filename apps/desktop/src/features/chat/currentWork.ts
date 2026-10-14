import { useMemo } from 'react'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import type { ChatSessionState, ToolState } from './chatItems'
import {
  isFleetActive,
  parseFleetWidget,
  SUBAGENT_ASYNC_WIDGET_KEY,
  SUBAGENT_SUPERVISOR_REQUEST_TYPE,
  subagentCall,
  subagentRun,
  type FleetNode,
  type FleetSnapshot,
} from './subagentRuns'
import { toolDetails, tryParseArgs } from './tools/toolSummaries'
import { distinctTitles, isSoloLaunch } from './subagentPresentation'

export interface WorkEntry {
  id: string
  /** The agent profile, e.g. `worker`. Several entries can share it. */
  label: string
  /**
   * The model the child runs on when pi-subagents reports it (foreground
   * details, or a background step's snapshot), else the one the parent asked
   * for. Unset: the agent's default, unknown here.
   */
  model?: string
  /** Display title from the delegated prompt; identity stays on the IDs below. */
  title?: string
  task?: string
  requestedAt?: number
  startedAt?: number
  endedAt?: number
  lastActivityAt?: number
  toolCount?: number
  turnCount?: number
  state: string
  active: number
  attention: boolean
  currentTool?: string
  currentToolStartedAt?: number
  toolCallId?: string
  runId?: string
  childId?: string
  /** A single-agent run, shown once: the run and its one step are the same work. */
  single?: boolean
  /** The workflow or parallel run this entry belongs to, or is (no `childId`). */
  group?: { id: string; label: string }
  /** A title when there is no single prompt, e.g. one call naming four tasks. */
  fallbackTitle?: string
}

/**
 * pi-subagents projects a single-agent run as a root plus its one step. That
 * is one agent, not two: show it once and route inspection to the step, the
 * only node whose session holds activity.
 */
export function singleStep(root: FleetNode): FleetNode | undefined {
  const [step] = root.children
  return root.kind !== 'workflow' &&
    root.children.length === 1 &&
    step?.kind === 'step' &&
    !step.children.length
    ? step
    : undefined
}

function nodeEntry(node: FleetNode, runId: string, childId?: string): WorkEntry {
  return {
    id: `${runId}:${node.id}`,
    label: node.label,
    model: node.model,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    lastActivityAt: node.lastActivityAt,
    toolCount: node.toolCount,
    turnCount: node.turnCount,
    state: node.state,
    active: Number(isFleetActive(node.state)),
    attention: node.attention,
    currentTool: node.currentTool,
    currentToolStartedAt: node.currentTool ? node.currentToolStartedAt : undefined,
    runId,
    childId,
  }
}

/** Count leaves, not a workflow and its children twice. Keep routing to the root. */
function backgroundEntries(nodes: FleetNode[], root?: FleetNode): WorkEntry[] {
  return nodes.flatMap((node) => {
    const step = root ? undefined : singleStep(node)
    if (step) {
      const own = nodeEntry(step, node.id, step.id)
      // The run's own state wins: a settled root settles its step, and a root
      // still finishing is not done because its step returned first.
      const state = isFleetActive(node.state) && isFleetActive(step.state) ? step.state : node.state
      return [
        {
          ...own,
          single: true,
          state,
          active: Number(isFleetActive(state)),
          attention: step.attention || node.attention,
          startedAt: step.startedAt ?? node.startedAt,
          endedAt: step.endedAt ?? node.endedAt,
          lastActivityAt: step.lastActivityAt ?? node.lastActivityAt,
          toolCount: step.toolCount ?? node.toolCount,
          turnCount: step.turnCount ?? node.turnCount,
          currentTool: step.currentTool ?? node.currentTool,
          currentToolStartedAt: step.currentTool
            ? step.currentToolStartedAt
            : node.currentTool
              ? node.currentToolStartedAt
              : undefined,
        },
      ]
    }
    const children = backgroundEntries(node.children, root ?? node)
    const group = root ?? (node.children.length ? node : undefined)
    const own: WorkEntry = {
      ...nodeEntry(node, root?.id ?? node.id, root ? node.id : undefined),
      ...(group ? { group: { id: group.id, label: group.label } } : {}),
    }
    if (!children.length) return [own]
    // A workflow can be coordinating between child runs. Its own activity is
    // counted only when no child is active, never on top of those children.
    if (own.active && !children.some((child) => child.active)) return [own, ...children]
    if (node.attention && !children.some((child) => child.attention)) {
      const active = children.find((child) => child.active)
      if (active) active.attention = true
    }
    return children
  })
}

/** The state shown for a child blocked on an unanswered `contact_supervisor`. */
export const WAITING_FOR_REPLY = 'waiting for reply'

/**
 * Runs with a supervisor request the parent has not answered. The request is
 * the child's own report that it is alive and blocked, so it stands in for the
 * live snapshot when that is missing. A reply is matched by request id only.
 * Only a request received during the parent run observed now counts: a replayed
 * one must not restore liveness after a restart.
 */
function unansweredRequests(chat: ChatSessionState | undefined): Set<string> {
  const since = chat?.agentStartedAt
  if (since == null) return new Set()
  const answered = new Set<string>()
  for (const tool of Object.values(chat?.tools ?? {})) {
    if (tool.toolName !== 'subagent_supervisor') continue
    const args = tool.args ?? tryParseArgs(tool.argsText)
    if (args?.action === 'reply' && typeof args.replyTo === 'string') answered.add(args.replyTo)
  }
  const waiting = new Set<string>()
  for (const item of chat?.items ?? []) {
    if (item.kind !== 'custom' || item.customType !== SUBAGENT_SUPERVISOR_REQUEST_TYPE) continue
    if (item.timestamp === undefined || item.timestamp < since) continue
    const d = item.details as
      { runId?: unknown; requestId?: unknown; id?: unknown; expectsReply?: unknown } | undefined
    const id = typeof d?.requestId === 'string' ? d.requestId : d?.id
    if (typeof d?.runId !== 'string' || typeof id !== 'string' || d.expectsReply === false) continue
    if (!answered.has(id)) waiting.add(d.runId)
  }
  return waiting
}

/**
 * pi-subagents withdraws its snapshot when an automatic compaction starts and
 * republishes it only when a parent turn starts or settles. pi compacts inside a
 * running turn, so for the rest of that turn no background status arrives.
 */
function statusPausedByCompaction(chat: ChatSessionState | undefined): boolean {
  if (!chat?.isStreaming) return false
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const item = chat.items[i]!
    if (item.kind === 'user') return false
    if (item.kind === 'divider' && item.variant === 'compaction' && item.reason !== 'manual')
      return true
  }
  return false
}

export function currentWork(
  chat: ChatSessionState | undefined,
  fleet: FleetSnapshot | null,
  remembered?: { snapshot: FleetSnapshot; receivedAt: number },
): {
  entries: WorkEntry[]
  incomplete: boolean
  lastSeen?: number
  /** No live snapshot because an automatic compaction ran in this parent turn. */
  statusPaused: boolean
} {
  const liveIds = new Set(fleet?.runs.map((run) => run.id))
  const missing = remembered?.snapshot.runs.filter((run) => !liveIds.has(run.id)) ?? []
  const runs = [...(fleet?.runs ?? []), ...missing]
  const represented = new Set<string>()
  const visit = (nodes: FleetNode[]): void => {
    for (const node of nodes) {
      represented.add(node.id)
      visit(node.children)
    }
  }
  visit(runs)
  // Only explicit native run IDs can settle missing status. Never match agent names.
  const completed = new Map<string, string>()
  for (const item of chat?.items ?? []) {
    if (item.kind !== 'custom' || item.customType !== 'subagent-notify') continue
    const details = item.details as { runs?: { runId?: string; status?: string }[] } | undefined
    if (!Array.isArray(details?.runs)) continue
    for (const run of details.runs) {
      if (
        run &&
        typeof run.runId === 'string' &&
        ['completed', 'complete', 'failed', 'stopped'].includes(run.status ?? '')
      )
        completed.set(run.runId, run.status!)
    }
  }
  const entries = runs.flatMap((root) => {
    if (liveIds.has(root.id)) return backgroundEntries([root])
    const terminal = completed.get(root.id)
    // A failed workflow does not prove every child failed. A root receipt
    // settles only the root; do not paint its outcome onto child rows.
    const step = singleStep(root)
    if (terminal)
      return [
        {
          id: root.id,
          label: step?.label ?? root.label,
          model: step?.model ?? root.model,
          startedAt: step?.startedAt ?? root.startedAt,
          endedAt: step?.endedAt ?? root.endedAt,
          toolCount: step?.toolCount ?? root.toolCount,
          turnCount: step?.turnCount ?? root.turnCount,
          state: terminal,
          active: 0,
          attention: false,
          runId: root.id,
          ...(step ? { childId: step.id, single: true } : {}),
        },
      ]
    return backgroundEntries([root]).map((entry) => ({
      ...entry,
      active: 0,
      attention: false,
      currentTool: undefined,
      currentToolStartedAt: undefined,
      state: entry.active ? 'status unavailable' : entry.state,
    }))
  })
  const requested = new Map<string, number>()
  for (const item of chat?.items ?? []) {
    if (item.kind !== 'assistant' || item.timestamp === undefined) continue
    for (const block of item.blocks) {
      if (block.type === 'tool') requested.set(block.toolCallId, item.timestamp)
    }
  }
  for (const tool of Object.values(chat?.tools ?? {})) {
    if (tool.toolName !== 'subagent') continue
    const call = subagentCall(tool.args ?? tryParseArgs(tool.argsText))
    if (call.kind !== 'launch') continue
    const settled = tool.status === 'done' || tool.status === 'error'
    const run = subagentRun(toolDetails(tool), settled)
    const detached = run?.async || call.async
    // Only the exact launch: a run's prompt belongs to the run (or its single
    // step); a parallel/chain step gets its own entry by native step index. A
    // workflow prompt is never a child's task.
    if (run?.runId) {
      for (const entry of entries) {
        if (entry.runId !== run.runId) continue
        const step = /^step:(\d+)$/.exec(entry.childId ?? '')
        const own = !entry.childId || entry.single
        const indexed =
          step && !call.workflow && !call.script ? call.tasks?.[Number(step[1])] : undefined
        const task = own
          ? (call.task ?? (call.tasks?.length === 1 ? call.tasks[0]!.task : undefined))
          : indexed?.task
        if (own || task) {
          entry.task = task
          entry.requestedAt = requested.get(tool.toolCallId) ?? tool.startedAt
        }
        // A step's own model wins over the call's; a workflow root names none.
        entry.model ??= own
          ? (call.model ?? (call.tasks?.length === 1 ? call.tasks[0]!.model : undefined))
          : (indexed?.model ?? (indexed ? call.model : undefined))
      }
    }
    if (run?.runId && represented.has(run.runId)) continue
    // A replayed/orphaned running tool must not revive when a later parent
    // turn starts. Only an execution observed within this turn is live.
    const live =
      !detached &&
      !settled &&
      !!chat?.isStreaming &&
      !chat.error &&
      chat.agentStartedAt != null &&
      tool.startedAt != null &&
      tool.startedAt >= chat.agentStartedAt
    const activeChildren = run?.children.filter(
      (child) => child.status === 'running' || child.status === 'pending',
    )
    const unique = (values: (string | undefined)[]): string | undefined =>
      [...new Set(values.filter((v): v is string => !!v))].join(', ') || undefined
    entries.push({
      id: tool.toolCallId,
      toolCallId: tool.toolCallId,
      runId: detached ? run?.runId : undefined,
      label:
        call.agent ??
        ([...new Set(call.tasks?.flatMap((t) => (t.agent ? [t.agent] : [])))].join(', ') ||
          'Workflow'),
      model:
        unique(run?.children.map((child) => child.model) ?? []) ??
        call.model ??
        unique(call.tasks?.map((t) => t.model) ?? []),
      task:
        call.task ?? call.workflow ?? (call.tasks?.length === 1 ? call.tasks[0]!.task : undefined),
      ...(!call.task && !call.workflow && (call.tasks?.length ?? 0) > 1
        ? { fallbackTitle: `${call.tasks!.length} delegated tasks` }
        : {}),
      requestedAt: requested.get(tool.toolCallId) ?? (detached ? tool.startedAt : undefined),
      startedAt: detached ? undefined : tool.startedAt,
      endedAt: detached ? undefined : tool.endedAt,
      state: detached
        ? (completed.get(run?.runId ?? '') ?? 'status unavailable')
        : live
          ? 'running'
          : tool.isError ||
              tool.status === 'error' ||
              run?.children.some((child) => child.status === 'failed')
            ? 'failed'
            : settled &&
                run?.children.length &&
                run.children.every((child) => child.status === 'completed')
              ? 'finished'
              : 'status unavailable',
      active: live ? (run?.children.length ? activeChildren!.length : 1) : 0,
      attention: false,
      currentTool: live
        ? activeChildren?.find((child) => child.currentTool)?.currentTool
        : undefined,
      toolCount: run?.children.length
        ? run.children.reduce((sum, child) => sum + (child.toolCount ?? 0), 0)
        : undefined,
      ...(detached && run?.runId && isSoloLaunch(call) ? { single: true } : {}),
    })
  }
  // A live snapshot is authoritative; this only replaces "no report".
  const waiting = unansweredRequests(chat)
  for (const entry of entries) {
    // A workflow's children share its run ID; the request names the run, not a child.
    const run = !entry.childId || entry.single
    if (entry.state !== 'status unavailable' || !run || !waiting.has(entry.runId ?? '')) continue
    entry.state = WAITING_FOR_REPLY
    entry.active = 1
    entry.attention = true
    // The only way a child asks is this tool, and it holds the child until answered.
    entry.currentTool = 'contact_supervisor'
  }
  // Compared across the whole lane, so a title does not change when its
  // agent finishes or a sibling starts.
  const titles = distinctTitles(entries.map((entry) => entry.task))
  entries.forEach((entry, i) => {
    entry.title = titles[i] ?? entry.fallbackTitle
  })
  return {
    entries,
    incomplete: !!(fleet ?? remembered?.snapshot)?.incomplete,
    lastSeen: missing.length ? remembered?.receivedAt : undefined,
    statusPaused: !fleet && statusPausedByCompaction(chat),
  }
}

const NO_TOOLS: Record<string, ToolState> = Object.freeze({})
export function useCurrentWork(sessionId: string) {
  const chat = useChatStore((s) => s.sessions[sessionId])
  const lines = useExtensionUiStore((s) => s.widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines)
  const remembered = useExtensionUiStore((s) => s.subagentSnapshots[sessionId])
  return useMemo(
    () => ({
      ...currentWork(chat, parseFleetWidget(lines), remembered),
      tools: chat?.tools ?? NO_TOOLS,
      items: chat?.items ?? [],
    }),
    [chat, lines, remembered],
  )
}
