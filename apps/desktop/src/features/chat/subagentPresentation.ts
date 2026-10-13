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

/** `/Users/me/repo/briefs/remote-trace.md` → `remote-trace.md`: titles, never routing. */
export const shortenPaths = (text: string): string =>
  text.replace(/(?<![\w.~/-])(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?/g, (path) =>
    path.replace(/\/$/, '').slice(path.replace(/\/$/, '').lastIndexOf('/') + 1),
  )

const unitCache = new Map<string, string[]>()

/** Sentences of a prompt's opening, normalized for comparison and display. */
function units(task: string): string[] {
  const cached = unitCache.get(task)
  if (cached) return cached
  const value = task
    .slice(0, 4000)
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z(`])/))
    .map((unit) =>
      shortenPaths(unit.replace(/^\s*(?:[#>*-]+|\d+[.)])\s*/, ''))
        .replace(/[`*_]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((unit) => unit.length > 1)
    .slice(0, 24)
  // Recomputed on every streamed token: keep it linear and bounded.
  if (unitCache.size >= 400) unitCache.delete(unitCache.keys().next().value!)
  unitCache.set(task, value)
  return value
}

/**
 * One readable title per prompt. Delegated prompts often share a long preamble
 * ("You are a worker…"), so a title is the first sentence no other prompt in
 * view contains. Display only; identity always comes from native run IDs.
 */
export function distinctTitles(tasks: (string | undefined)[]): (string | undefined)[] {
  const all = tasks.map((task) => (task ? units(task) : []))
  const prompts = new Map<string, number>()
  for (const own of all)
    for (const unit of new Set(own)) prompts.set(unit, (prompts.get(unit) ?? 0) + 1)
  return all.map((own) => {
    if (!own.length) return undefined
    const title = own.find((unit) => prompts.get(unit) === 1) ?? own[0]!
    return title.length > 120 ? `${title.slice(0, 119)}…` : title
  })
}

/** 12s · 7m 05s · 1h 04m. Elapsed is shown only from an explicit native start. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

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

const QUIET_AFTER_MS = 15_000

/**
 * What a running agent is doing, from reported facts only: its open tool, else
 * whether it reported activity recently. Counters come from the snapshot.
 */
export function activityText(
  entry: {
    active: number
    currentTool?: string
    currentToolStartedAt?: number
    lastActivityAt?: number
    toolCount?: number
  },
  now: number,
): string {
  const parts: string[] = []
  if (entry.active && entry.currentTool)
    parts.push(
      entry.currentToolStartedAt !== undefined
        ? `${entry.currentTool} ${elapsed(now - entry.currentToolStartedAt)}`
        : entry.currentTool,
    )
  else if (entry.active && entry.lastActivityAt !== undefined)
    parts.push(
      now - entry.lastActivityAt < QUIET_AFTER_MS
        ? 'working'
        : `quiet ${elapsed(now - entry.lastActivityAt)}`,
    )
  else if (entry.active) parts.push('working')
  if (entry.toolCount !== undefined)
    parts.push(`${entry.toolCount} ${entry.toolCount === 1 ? 'tool' : 'tools'}`)
  return parts.join(' · ')
}

const STATE_WORDS: Record<string, string> = {
  complete: 'done',
  completed: 'done',
  finished: 'done',
  partial: 'partial',
}
export const stateWord = (state: string): string => STATE_WORDS[state] ?? state

export interface SupervisorHandoff {
  kind?: 'tool-result' | 'notification'
  input?: string
  output?: string
  receivedAt?: number
}

/**
 * Parent-owned receipts only. A containing workflow's answer is NOT a child's
 * answer. `single` marks the one step of a single-agent run: that step IS the
 * launch, so the launch prompt and its receipts are its own. A parallel or
 * chain step gets only its own prompt, by native step index.
 */
export function supervisorHandoff(
  tools: Record<string, ToolState>,
  items: ChatItem[],
  target: SubagentTarget,
  { single = false }: { single?: boolean } = {},
): SupervisorHandoff {
  const handoff: SupervisorHandoff = {}
  const asRun = !target.childId || single
  const step = /^step:(\d+)$/.exec(target.childId ?? '')
  for (const tool of Object.values(tools)) {
    if (tool.toolName !== 'subagent') continue
    const settled = tool.status === 'done' || tool.status === 'error'
    const run = subagentRun(toolDetails(tool), settled)
    if (run?.runId !== target.runId) continue
    const call = subagentCall(tool.args ?? tryParseArgs(tool.argsText))
    if (call.kind !== 'launch') continue
    if (!asRun) {
      if (step) handoff.input = call.tasks?.[Number(step[1])]?.task
      continue
    }
    handoff.input = call.task ?? (call.tasks?.length === 1 ? call.tasks[0]!.task : undefined)
    if (settled && !run.async && !call.async) {
      handoff.kind = 'tool-result'
      handoff.output = toolText({ ...tool, output: tool.result ?? tool.output }) || undefined
      handoff.receivedAt = tool.endedAt
    }
  }
  for (const item of items) {
    if (item.kind !== 'custom' || !item.inContext) continue
    const notice = parseSubagentNotice(item.customType, item.text, item.details)
    if (notice?.kind !== 'completion') continue
    const details = item.details as { runs?: { runId?: string }[] } | undefined
    const whole =
      asRun &&
      Array.isArray(details?.runs) &&
      details.runs.length === 1 &&
      details.runs[0]?.runId === target.runId
    const child =
      notice.runId &&
      (asRun
        ? notice.runId === target.runId
        : notice.runId === target.childId && notice.workflowRunId === target.runId)
    if (whole || child) {
      handoff.kind = 'notification'
      handoff.output = item.text
      handoff.receivedAt = item.timestamp
    }
  }
  return handoff
}
