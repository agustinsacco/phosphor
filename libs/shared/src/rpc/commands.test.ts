import { expect, expectTypeOf, it } from 'vitest'
import type { QueueMode, RpcCommand, RpcCommandType, StreamingBehavior } from './commands'
import type { ImageContent } from './messages'

it('allows an optional correlation id on every command', () => {
  expectTypeOf<RpcCommand['id']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<RpcCommandType>().toEqualTypeOf<RpcCommand['type']>()
  const commands: RpcCommand[] = [{ type: 'abort' }, { type: 'abort', id: 'request' }]
  expect(commands.map((command) => command.id)).toEqual([undefined, 'request'])
})

it('preserves prompt fields and queue modes exactly', () => {
  expectTypeOf<Extract<RpcCommand, { type: 'prompt' }>>().toEqualTypeOf<{
    id?: string
    type: 'prompt'
    message: string
    images?: ImageContent[]
    streamingBehavior?: StreamingBehavior
  }>()
  expectTypeOf<StreamingBehavior>().toEqualTypeOf<'steer' | 'followUp'>()
  expectTypeOf<QueueMode>().toEqualTypeOf<'all' | 'one-at-a-time'>()
  expectTypeOf<Extract<RpcCommand, { type: 'get_entries' }>>().toEqualTypeOf<{
    id?: string
    type: 'get_entries'
    since?: string
  }>()
})
