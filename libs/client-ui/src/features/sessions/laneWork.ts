import type { ToolState } from '@/features/chat/chatItems'
import type { WorkEntry } from '@/features/chat/currentWork'
import { summarizeTool } from '@/features/chat/tools/toolSummaries'

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
export function laneAgents(entries: WorkEntry[], since: number | null): LaneAgents | null {
  const agents = entries
    .filter((e) => e.active > 0 || (since !== null && (e.endedAt ?? 0) >= since))
    .map((e) => ({
      id: e.id,
      label: e.label,
      detail: (e.active > 0 && e.currentTool) || e.title || e.task,
      running: e.active > 0,
      failed: e.state === 'failed',
    }))
  const running = agents.filter((a) => a.running).length
  return running ? { running, agents } : null
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
