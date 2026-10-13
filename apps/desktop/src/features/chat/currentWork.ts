import { useMemo } from 'react'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import type { ChatSessionState, ToolState } from './chatItems'
import {
  isFleetActive,
  parseFleetWidget,
  SUBAGENT_ASYNC_WIDGET_KEY,
  subagentCall,
  subagentRun,
  type FleetNode,
  type FleetSnapshot,
} from './subagentRuns'
import { toolDetails, tryParseArgs } from './tools/toolSummaries'
import { distinctTitles } from './subagentPresentation'

export interface WorkEntry {
  id: string
  /** The agent profile, e.g. `worker`. Several entries can share it. */
  label: string
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
  /** The one step of a single-agent run: the run and the agent are the same work. */
  single?: boolean
  /** The workflow or parallel run this child belongs to. */
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
    const own: WorkEntry = {
      ...nodeEntry(node, root?.id ?? node.id, root ? node.id : undefined),
      ...(root ? { group: { id: root.id, label: root.label } } : {}),
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

export function currentWork(
  chat: ChatSessionState | undefined,
  fleet: FleetSnapshot | null,
  remembered?: { snapshot: FleetSnapshot; receivedAt: number },
): { entries: WorkEntry[]; incomplete: boolean; lastSeen?: number } {
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
          startedAt: step?.startedAt ?? root.startedAt,
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
        const task =
          !entry.childId || entry.single
            ? (call.task ?? (call.tasks?.length === 1 ? call.tasks[0]!.task : undefined))
            : step && !call.workflow && !call.script
              ? call.tasks?.[Number(step[1])]?.task
              : undefined
        if (!entry.childId || entry.single || task) {
          entry.task = task
          entry.requestedAt = requested.get(tool.toolCallId) ?? tool.startedAt
        }
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
    entries.push({
      id: tool.toolCallId,
      toolCallId: tool.toolCallId,
      runId: detached ? run?.runId : undefined,
      label:
        call.agent ??
        ([...new Set(call.tasks?.flatMap((t) => (t.agent ? [t.agent] : [])))].join(', ') ||
          'Workflow'),
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
    })
  }
  // Titles are compared within the set a reader sees together: current work
  // apart from history, so an old launch cannot hide a live brief's name.
  const current = entries.filter((e) => e.active || e.state === 'status unavailable')
  const past = entries.filter((e) => !current.includes(e))
  for (const set of [current, past]) {
    const titles = distinctTitles(set.map((entry) => entry.task))
    set.forEach((entry, i) => {
      entry.title = titles[i] ?? entry.fallbackTitle
    })
  }
  return {
    entries,
    incomplete: !!(fleet ?? remembered?.snapshot)?.incomplete,
    lastSeen: missing.length ? remembered?.receivedAt : undefined,
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
