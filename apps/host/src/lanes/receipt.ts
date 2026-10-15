import { isExternalToolMarker } from '@phosphor/shared/external-tool-marker'
import { excerptOf } from '@phosphor/shared/lane-excerpt'
import {
  messageReceiptTools,
  receiptDuration,
  receiptFacts,
  settledReceiptMessages,
  type LaneReceipt,
} from '@phosphor/shared/lane-receipt'
import type { AgentMessage } from '@phosphor/shared/rpc'

export function hostLaneReceipt(
  messages: readonly AgentMessage[],
  meta: Pick<LaneReceipt, 'title' | 'repository' | 'branch'>,
  timing?: { start: number; end: number },
  workspacePath?: string,
): LaneReceipt {
  let run = settledReceiptMessages(messages)
  if (timing && receiptDuration(timing.start, timing.end) !== null) {
    const bounded = messages.filter(
      (message) => message.timestamp === undefined || message.timestamp <= timing.end,
    )
    let start = bounded.length - 1
    while (start >= 0) {
      const message = bounded[start]
      if (
        message?.role === 'user' &&
        message.timestamp !== undefined &&
        message.timestamp <= timing.start
      )
        break
      start--
    }
    if (start >= 0) run = bounded.slice(start)
  }
  const last = [...run].reverse().find((message) => message.role === 'assistant')
  const error = last?.role === 'assistant' && (last.stopReason === 'error' || !!last.errorMessage)
  let excerpt: string | undefined
  if (error && last?.role === 'assistant') excerpt = excerptOf(last.errorMessage ?? '')
  else
    for (let i = run.length - 1; i >= 0; i--) {
      const message = run[i]
      if (message?.role === 'user') break
      if (message?.role !== 'assistant') continue
      excerpt = excerptOf(
        message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .filter((text) => !isExternalToolMarker(text))
          .join('\n'),
      )
      if (excerpt) break
    }
  return {
    ...meta,
    settledAt: receiptDuration(
      0,
      timing && receiptDuration(timing.start, timing.end) !== null ? timing.end : last?.timestamp,
    ),
    ...receiptFacts(messageReceiptTools(run), workspacePath),
    durationMs:
      (timing ? receiptDuration(timing.start, timing.end) : null) ??
      receiptDuration(run[0]?.timestamp, last?.timestamp),
    excerpt: excerpt ?? null,
    outcome: error ? 'error' : 'done',
  }
}
