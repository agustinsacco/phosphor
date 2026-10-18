import { expect, expectTypeOf, it } from 'vitest'
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ImageContent,
  Model,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultMessage,
  Usage,
  UserContentBlock,
} from './messages'

it('accepts historical messages without usage totals, costs or duration', () => {
  const usage: Usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  const assistant: AssistantMessage = { role: 'assistant', content: [], usage }
  const result: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: 'call',
    toolName: 'read',
    content: [],
    isError: false,
  }
  expect(assistant.usage).not.toHaveProperty('totalTokens')
  expect(assistant.usage).not.toHaveProperty('cost')
  expect(result).not.toHaveProperty('durationMs')
})

it('keeps content and message discriminants distinct', () => {
  expectTypeOf<AssistantContentBlock>().toEqualTypeOf<
    TextContent | ThinkingContent | ToolCallContent
  >()
  expectTypeOf<UserContentBlock>().toEqualTypeOf<TextContent | ImageContent>()
  expectTypeOf<AgentMessage['role']>().toEqualTypeOf<
    | 'user'
    | 'assistant'
    | 'toolResult'
    | 'bashExecution'
    | 'custom'
    | 'customMessage'
    | 'branchSummary'
    | 'compactionSummary'
  >()
  expectTypeOf<ToolCallContent['arguments']>().toEqualTypeOf<Record<string, unknown>>()
})

it('retains nullable thinking overrides and extensible model metadata', () => {
  expectTypeOf<Model['thinkingLevelMap']>().toEqualTypeOf<
    | Partial<
        Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>
      >
    | null
    | undefined
  >()
  expectTypeOf<Model['providerMetadata']>().toEqualTypeOf<unknown>()
})
