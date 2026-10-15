import type { ChatItem, ToolState } from '@/features/chat/chatItems'
import { laneOutcome } from '@/lib/laneNotice'
import { receiptDuration, receiptFacts, type LaneReceipt } from '@shared/lane-receipt'

export function laneReceipt(input: {
  items: readonly ChatItem[]
  tools: Record<string, ToolState>
  workspacePath?: string
  title: string
  repository: string | null
  branch: string | null
  startedAt?: number | null
  settledAt?: number
}): LaneReceipt {
  let start = input.items.length - 1
  while (start >= 0 && input.items[start]?.kind !== 'user') start--
  if (input.startedAt !== undefined && input.startedAt !== null) {
    for (let i = input.items.length - 1; i >= 0; i--) {
      const item = input.items[i]
      if (
        item?.kind === 'user' &&
        item.timestamp !== undefined &&
        item.timestamp <= input.startedAt
      ) {
        start = i
        break
      }
    }
  }
  const items = input.items.slice(Math.max(0, start))
  const ids = new Set(
    items.flatMap((item) =>
      item.kind === 'assistant'
        ? item.blocks.flatMap((block) => (block.type === 'tool' ? [block.toolCallId] : []))
        : [],
    ),
  )
  const tools = Object.values(input.tools)
    .filter((tool) => ids.has(tool.toolCallId))
    .map((tool) => ({
      name: tool.toolName,
      args: tool.args,
      done: tool.status === 'done' || tool.status === 'error',
      error: tool.isError,
      details: tool.result?.details,
      text: tool.result?.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    }))
  const outcome = laneOutcome(items)
  return {
    title: input.title,
    repository: input.repository,
    branch: input.branch,
    settledAt: receiptDuration(0, input.settledAt),
    durationMs: receiptDuration(input.startedAt, input.settledAt),
    ...receiptFacts(tools, input.workspacePath),
    excerpt: outcome.excerpt ?? null,
    outcome: outcome.kind,
  }
}

const MACHINE_COLOURS = ['#648bd2', '#9b78c6', '#c17c56', '#4e9d92', '#b584b1']
export function machineColour(machineId?: string): string {
  if (!machineId) return '#729568'
  let hash = 0
  for (const char of machineId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return MACHINE_COLOURS[hash % MACHINE_COLOURS.length] ?? '#648bd2'
}

export interface ToastReceipt {
  laneId?: string
  facts?: LaneReceipt
  machine: string
  machineId?: string
  at: string
}
