import { expect, it, vi } from 'vitest'
import * as controls from './lane-controls'
import type { RpcSessionState } from '@phosphor/shared/rpc'

it('reads only the asking lane and never returns effects or deferred changes', async () => {
  const state = vi.fn(async () => ({ autoCompactionEnabled: false, thinkingLevel: 'low' }) as RpcSessionState)
  const handler = controls.laneControlsRead(state)
  const lane = { sessionId: 'self', ref: 'local/session:self' }
  const ctx = { principal: { kind: 'agent', sessionId: 'self', laneRef: lane.ref }, lane } as never
  const reply = await handler({}, ctx)
  expect(reply.data).toMatchObject({ effective: { thinking: 'low', autoCompaction: false } })
  expect(reply.effects).toBeUndefined()
  expect(reply.deferred).toBeUndefined()
  await expect(handler({}, { principal: { kind: 'local' }, lane } as never)).rejects.toThrow(/inside/i)
  expect(state).toHaveBeenCalledTimes(1)
})
