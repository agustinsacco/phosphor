import type { ToolState } from '@/features/chat/chatItems'
import type { WorkEntry } from '@/features/chat/currentWork'
import { subagentCall, subagentRun } from '@/features/chat/subagentRuns'
import { summarizeTool, toolDetails, tryParseArgs } from '@/features/chat/tools/toolSummaries'

export interface LaneAgent {
  id: string
  label: string
  /** What it is on while running, else its task title. */
  detail?: string
  running: boolean
  failed: boolean
}

export interface LaneAgents {
  running: number
  agents: LaneAgent[]
}

/**
 * The sub-agents a sidebar row shows: every one still running, plus those that
 * finished during the parent's current turn, so `2/3` reads as progress.
 * Null once none run, so a lane's history of delegation never clutters it.
 */
export function laneAgents(
  entries: WorkEntry[],
  since: number | null,
  tools: Record<string, ToolState>,
): LaneAgents | null {
  const agents = entries
    .filter((e) => e.active > 0 || (since !== null && (e.endedAt ?? 0) >= since))
    .flatMap((e) => entryAgents(e, tools))
  const running = agents.filter((a) => a.running).length
  return running ? { running, agents } : null
}

/** One agent per entry, except a foreground batch, which is one per child. */
function entryAgents(e: WorkEntry, tools: Record<string, ToolState>): LaneAgent[] {
  const live = e.active > 0
  const tool = e.toolCallId && !e.runId ? tools[e.toolCallId] : undefined
  const settled = tool?.status === 'done' || tool?.status === 'error'
  const children = tool ? (subagentRun(toolDetails(tool), settled)?.children ?? []) : []
  if (children.length < 2)
    return [
      {
        id: e.id,
        label: e.label,
        detail: (live && e.currentTool) || e.title || e.task,
        running: live,
        failed: e.state === 'failed',
      },
    ]
  const call = subagentCall(tool!.args ?? tryParseArgs(tool!.argsText))
  const tasks = call.kind === 'launch' ? call.tasks : undefined
  return children.map((c) => ({
    id: `${e.id}:${c.index}`,
    label: c.agent,
    detail: (live && c.currentTool) || tasks?.[c.index]?.task || c.label,
    running: live && (c.status === 'running' || c.status === 'pending'),
    failed: c.status === 'failed',
  }))
}

/** The parent's newest running tool this turn, as `Reading registry.ts`. */
export function laneDoing(
  tools: Record<string, ToolState>,
  since: number | null,
): string | undefined {
  let latest: ToolState | undefined
  for (const tool of Object.values(tools)) {
    if (tool.status !== 'starting' && tool.status !== 'running') continue
    // A replayed tool that never settled is not this turn's work.
    if (since === null || (tool.startedAt ?? 0) < since) continue
    if (!latest || (tool.startedAt ?? 0) >= (latest.startedAt ?? 0)) latest = tool
  }
  if (!latest) return undefined
  const summary = summarizeTool(latest)
  return summary.object ? `${summary.label} ${summary.object}` : summary.label
}
