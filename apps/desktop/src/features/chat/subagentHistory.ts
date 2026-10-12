import { sessionBranch } from '@shared/session-branch'
import type { ChatItem, CustomItem, ToolState } from './chatItems'
import {
  isSubagentNotice,
  parseSubagentNotice,
  subagentCall,
  subagentRun,
  SUBAGENT_SUPERVISOR_REPLY_TYPE,
  SUBAGENT_SUPERVISOR_REQUEST_TYPE,
} from './subagentRuns'
import { appendCustomItem } from './subagentReceipts'

export interface RecordedLaunch {
  id: string
  label: string
  task?: string
  requestedAt?: number
  returnedAt?: number
  receipt?: string
  detached?: boolean
  runId?: string
  outcome: string
}

/** Pair only native request/run identities, never profile labels or proximity. */
export function recordedReply(
  question: CustomItem,
  items: CustomItem[],
  tools: Record<string, ToolState> = {},
): string | undefined {
  if (question.customType !== SUBAGENT_SUPERVISOR_REQUEST_TYPE) return
  const q = record(question.details)
  const id = q?.requestId ?? q?.id
  if (typeof id !== 'string' || typeof q?.runId !== 'string') return
  const reply = items.findLast((item) => {
    const d = record(item.details)
    return (
      item.customType === SUBAGENT_SUPERVISOR_REPLY_TYPE &&
      d?.requestId === id &&
      d.runId === q.runId &&
      d.childIndex === q.childIndex
    )
  })
  if (reply) return reply.text
  // Live plain entries do not have RPC events. A successful native tool result
  // carries the same exact correlation; arguments alone are not delivery proof.
  for (const tool of Object.values(tools)) {
    const d = record(tool.result?.details)
    if (
      tool.toolName === 'subagent_supervisor' &&
      tool.status === 'done' &&
      !tool.isError &&
      d?.replyTo === id &&
      d.runId === q.runId &&
      tool.args?.replyTo === id &&
      typeof tool.args.message === 'string'
    )
      return tool.args.message
  }
}

type Entry = Record<string, unknown> & { id: string; parentId: string | null }
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** Native persisted evidence only. Plain custom replies never become model-context messages. */
export function subagentHistory(
  entries: unknown[],
  leafId: string | null,
): {
  items: CustomItem[]
  omitted: number
  launches: RecordedLaunch[]
  omittedLaunches: number
  runIds: Set<string>
} {
  const valid = entries.filter((e): e is Entry => {
    const entry = record(e)
    return (
      typeof entry?.id === 'string' &&
      (entry.parentId === null || typeof entry.parentId === 'string')
    )
  })
  if (leafId !== null && !valid.some((e) => e.id === leafId))
    throw new Error('The active history branch is unavailable.')
  const items: ChatItem[] = []
  const launches = new Map<string, RecordedLaunch>()
  const runIds = new Set<string>()
  for (const entry of sessionBranch(valid, leafId)) {
    const message = entry.type === 'message' ? record(entry.message) : entry
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = record(value)
        if (block?.type !== 'toolCall' || block.name !== 'subagent' || typeof block.id !== 'string')
          continue
        const call = subagentCall(record(block.arguments))
        if (call.kind === 'manage' && call.action !== 'resume') continue
        launches.set(block.id, {
          id: `${entry.id}:${block.id}`,
          label:
            call.kind === 'launch'
              ? `Launch request: ${call.agent ?? call.workflow ?? 'workflow'}`
              : 'Resume request',
          task: call.kind === 'launch' ? call.task : undefined,
          detached: call.kind === 'launch' && call.async,
          requestedAt:
            typeof message.timestamp === 'number'
              ? message.timestamp
              : typeof entry.timestamp === 'string'
                ? Date.parse(entry.timestamp)
                : undefined,
          outcome: 'No recorded result.',
        })
      }
    }
    if (
      message?.role === 'toolResult' &&
      message.toolName === 'subagent' &&
      typeof message.toolCallId === 'string'
    ) {
      const launch = launches.get(message.toolCallId)
      if (launch) {
        const run = subagentRun(message.details, true)
        launch.runId = run?.runId
        launch.detached ||= run?.async
        launch.returnedAt =
          typeof message.timestamp === 'number'
            ? message.timestamp
            : typeof entry.timestamp === 'string'
              ? Date.parse(entry.timestamp)
              : undefined
        launch.receipt = Array.isArray(message.content)
          ? message.content
              .flatMap((value) => {
                const block = record(value)
                return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
              })
              .join('\n')
          : undefined
        if (launch.runId) runIds.add(launch.runId)
        launch.outcome = message.isError
          ? 'The call failed.'
          : launch.detached
            ? 'Detached launch receipt, not current running status.'
            : run?.children.length
              ? `Reported child states: ${run.children.map((c) => `${c.agent}: ${c.status}`).join('; ')}`
              : 'No recorded child outcome.'
      }
    }
    if (!message || typeof message.customType !== 'string' || !isSubagentNotice(message.customType))
      continue
    const reply = entry.type === 'custom' && message.customType === SUBAGENT_SUPERVISOR_REPLY_TYPE
    if (
      !reply &&
      entry.type !== 'custom_message' &&
      !(entry.type === 'message' && (message.role === 'custom' || message.role === 'customMessage'))
    )
      continue
    const details = reply ? entry.data : message.details
    const content = message.content
    const text = reply
      ? record(details)?.message
      : typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((b) => {
                const block = record(b)
                return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
              })
              .join('\n')
          : undefined
    if (typeof text !== 'string') continue
    const notice = parseSubagentNotice(message.customType, text, details)
    if (notice?.runId) runIds.add(notice.runId)
    if (notice?.workflowRunId) runIds.add(notice.workflowRunId)
    appendCustomItem(items, {
      id: entry.id,
      kind: 'custom',
      customType: message.customType,
      details,
      text,
      inContext: !reply,
      quiet: message.display === false,
      timestamp:
        typeof message.timestamp === 'number'
          ? message.timestamp
          : typeof entry.timestamp === 'string'
            ? Date.parse(entry.timestamp)
            : undefined,
    })
  }
  return {
    items: items.slice(-200) as CustomItem[],
    omitted: Math.max(0, items.length - 200),
    launches: [...launches.values()].slice(-200),
    omittedLaunches: Math.max(0, launches.size - 200),
    runIds,
  }
}
