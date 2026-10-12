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

export interface WorkEntry {
  id: string
  label: string
  state: string
  active: number
  attention: boolean
  currentTool?: string
  toolCallId?: string
  runId?: string
  childId?: string
}

/** Count leaves, not a workflow and its children twice. Keep routing to the root. */
function backgroundEntries(nodes: FleetNode[], rootId?: string): WorkEntry[] {
  return nodes.flatMap((node) => {
    const children = backgroundEntries(node.children, rootId ?? node.id)
    const own: WorkEntry = {
      id: `${rootId ?? node.id}:${node.id}`,
      label: node.label,
      state: node.state,
      active: Number(isFleetActive(node.state)),
      attention: node.attention,
      currentTool: node.currentTool,
      runId: rootId ?? node.id,
      childId: rootId ? node.id : undefined,
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
    if (terminal)
      return [
        {
          id: root.id,
          label: root.label,
          state: terminal,
          active: 0,
          attention: false,
          runId: root.id,
        },
      ]
    return backgroundEntries([root]).map((entry) => ({
      ...entry,
      active: 0,
      attention: false,
      currentTool: undefined,
      state: entry.active ? 'status unavailable' : entry.state,
    }))
  })
  for (const tool of Object.values(chat?.tools ?? {})) {
    if (tool.toolName !== 'subagent') continue
    const call = subagentCall(tool.args ?? tryParseArgs(tool.argsText))
    if (call.kind !== 'launch') continue
    const settled = tool.status === 'done' || tool.status === 'error'
    const run = subagentRun(toolDetails(tool), settled)
    if (run?.runId && represented.has(run.runId)) continue
    const detached = run?.async || call.async
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
      label: call.agent ?? 'Workflow',
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
    }),
    [chat, lines, remembered],
  )
}
