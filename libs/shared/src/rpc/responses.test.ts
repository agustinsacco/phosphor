import { expect, expectTypeOf, it } from 'vitest'
import type { PromptDisposition, QueuedInputDisposition } from './commands'
import type { Model, ThinkingLevel } from './messages'
import type {
  RpcErrorResponse,
  RpcResponse,
  RpcResponseDataMap,
  RpcSuccessResponse,
} from './responses'

it('preserves success and error envelope fields and optional payloads', () => {
  expectTypeOf<RpcSuccessResponse<string>>().toEqualTypeOf<{
    id?: string
    type: 'response'
    command: string
    success: true
    data?: string
  }>()
  expectTypeOf<RpcErrorResponse>().toEqualTypeOf<{
    id?: string
    type: 'response'
    command: string
    success: false
    error: string
  }>()
  const response: RpcResponse = { type: 'response', command: 'abort', success: true }
  expect(response).not.toHaveProperty('data')
})

it('keeps per-command disposition, model, cancellation and opaque tree payloads', () => {
  expectTypeOf<RpcResponseDataMap['prompt']>().toEqualTypeOf<{ disposition: PromptDisposition }>()
  expectTypeOf<RpcResponseDataMap['steer']>().toEqualTypeOf<{
    disposition: QueuedInputDisposition
  }>()
  expectTypeOf<RpcResponseDataMap['follow_up']>().toEqualTypeOf<{
    disposition: QueuedInputDisposition
  }>()
  expectTypeOf<RpcResponseDataMap['abort']>().toEqualTypeOf<undefined>()
  expectTypeOf<RpcResponseDataMap['cycle_model']>().toEqualTypeOf<{
    model: Model
    thinkingLevel: ThinkingLevel
    isScoped: boolean
  } | null>()
  expectTypeOf<RpcResponseDataMap['fork']>().toEqualTypeOf<{ text: string; cancelled: boolean }>()
  expectTypeOf<RpcResponseDataMap['get_entries']>().toEqualTypeOf<{
    entries: unknown[]
    leafId: string | null
  }>()
  expectTypeOf<RpcResponseDataMap['get_tree']>().toEqualTypeOf<{
    tree: unknown[]
    leafId: string | null
  }>()
})
