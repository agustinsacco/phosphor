import type { ChatItem, ToolState } from './chatItems'
import type { SubagentTarget } from './subagentView'
import { parseSubagentNotice, subagentCall, subagentRun } from './subagentRuns'
import { toolDetails, toolText, tryParseArgs } from './tools/toolSummaries'

export const taskPreview = (task: string): string =>
  task
    .replace(/^[\s#>*-]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)

export function workTime(startedAt?: number, endedAt?: number, requestedAt?: number): string {
  const stamp = endedAt ?? startedAt ?? requestedAt
  if (stamp === undefined || !Number.isFinite(stamp)) return 'Time not reported'
  return `${endedAt !== undefined ? 'Ended' : startedAt !== undefined ? 'Started' : 'Requested'} ${new Date(
    stamp,
  ).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

/** Stable newest-first ordering. Never substitute snapshot read time for execution time. */
export function newestWork<
  T extends { startedAt?: number; endedAt?: number; requestedAt?: number },
>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (b.entry.startedAt ?? b.entry.requestedAt ?? b.entry.endedAt ?? 0) -
          (a.entry.startedAt ?? a.entry.requestedAt ?? a.entry.endedAt ?? 0) || b.index - a.index,
    )
    .map(({ entry }) => entry)
}

export interface SupervisorHandoff {
  kind?: 'tool-result' | 'notification'
  input?: string
  output?: string
  receivedAt?: number
}

/** Parent-owned receipts only. A containing workflow's answer is NOT a child's answer. */
export function supervisorHandoff(
  tools: Record<string, ToolState>,
  items: ChatItem[],
  target: SubagentTarget,
): SupervisorHandoff {
  const handoff: SupervisorHandoff = {}
  if (!target.childId) {
    for (const tool of Object.values(tools)) {
      if (tool.toolName !== 'subagent') continue
      const settled = tool.status === 'done' || tool.status === 'error'
      const run = subagentRun(toolDetails(tool), settled)
      if (run?.runId !== target.runId) continue
      const call = subagentCall(tool.args ?? tryParseArgs(tool.argsText))
      if (call.kind !== 'launch') continue
      handoff.input = call.task
      if (settled && !run.async && !call.async) {
        handoff.kind = 'tool-result'
        handoff.output = toolText({ ...tool, output: tool.result ?? tool.output }) || undefined
        handoff.receivedAt = tool.endedAt
      }
    }
  }
  for (const item of items) {
    if (item.kind !== 'custom' || !item.inContext) continue
    const notice = parseSubagentNotice(item.customType, item.text, item.details)
    if (notice?.kind !== 'completion') continue
    const details = item.details as { runs?: { runId?: string }[] } | undefined
    const single =
      Array.isArray(details?.runs) &&
      details.runs.length === 1 &&
      details.runs[0]?.runId === target.runId &&
      !target.childId
    const child =
      notice.runId &&
      (target.childId
        ? notice.runId === target.childId && notice.workflowRunId === target.runId
        : notice.runId === target.runId)
    if (single || child) {
      handoff.kind = 'notification'
      handoff.output = item.text
      handoff.receivedAt = item.timestamp
    }
  }
  return handoff
}
