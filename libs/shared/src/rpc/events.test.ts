import { expect, expectTypeOf, it } from 'vitest'
import type { AssistantMessageEvent, CompactionReason, PiEvent } from './events'
import type { ToolCallContent, Usage } from './messages'

it('retains streamed text, thinking and tool identity without cumulative snapshots', () => {
  expectTypeOf<Extract<AssistantMessageEvent, { type: 'text_delta' }>>().toEqualTypeOf<{
    type: 'text_delta'
    contentIndex: number
    delta: string
  }>()
  expectTypeOf<Extract<AssistantMessageEvent, { type: 'thinking_delta' }>>().toEqualTypeOf<{
    type: 'thinking_delta'
    contentIndex: number
    delta: string
  }>()
  expectTypeOf<Extract<AssistantMessageEvent, { type: 'toolcall_start' }>>().toEqualTypeOf<{
    type: 'toolcall_start'
    contentIndex: number
    id?: string
    toolName?: string
  }>()
  expectTypeOf<
    Extract<AssistantMessageEvent, { type: 'toolcall_end' }>['toolCall']
  >().toEqualTypeOf<ToolCallContent | undefined>()
  expectTypeOf<Extract<PiEvent, { type: 'message_update' }>>().toEqualTypeOf<{
    type: 'message_update'
    usage?: Usage
    assistantMessageEvent: AssistantMessageEvent
  }>()
})

it('retains nested execution IDs on every tool event and settled abort state', () => {
  type ToolEvent = Extract<PiEvent, { type: `tool_execution_${string}` }>
  expectTypeOf<ToolEvent['parentToolCallId']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<Extract<PiEvent, { type: 'agent_settled' }>>().toEqualTypeOf<{
    type: 'agent_settled'
    aborted: boolean
  }>()
  const settled: PiEvent = { type: 'agent_settled', aborted: false }
  expect(settled.aborted).toBe(false)
})

it('requires a compaction reason only for compaction summarization retries', () => {
  expectTypeOf<Extract<PiEvent, { type: 'summarization_retry_attempt_start' }>>().toEqualTypeOf<
    | { type: 'summarization_retry_attempt_start'; source: 'branchSummary' }
    | { type: 'summarization_retry_attempt_start'; source: 'compaction'; reason: CompactionReason }
  >()
})
