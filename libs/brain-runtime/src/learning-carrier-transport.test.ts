import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { commandLearningCarrier } from './learning-carrier-transport'
function client(frame: unknown, disposition = 'handled') {
  const emitter = Object.assign(new EventEmitter(), {
    killNow: vi.fn(),
    request: vi.fn(async () => {
      emitter.emit('extension-ui', {
        method: 'setStatus',
        statusKey: 'phosphor-brain-learning',
        statusText: typeof frame === 'string' ? frame : JSON.stringify(frame),
      })
      return { success: true, data: { disposition } }
    }),
  })
  return emitter
}
const nonce = 'a'.repeat(64)
const frame = { version: 1, nonce, jobId: 'job', operation: 'prepare', ok: true }
it('requires a job/nonce/operation acknowledgement AND handled disposition without ordinary inference', async () => {
  const owned = client(frame)
  await expect(
    commandLearningCarrier(
      owned as unknown as PiRpcClient,
      'job',
      nonce,
      'prepare',
      new AbortController().signal,
    ),
  ).resolves.toBe(true)
  expect(owned.request).toHaveBeenCalledExactlyOnceWith({
    type: 'prompt',
    message: `/phosphor-brain-learning ${nonce} prepare`,
  })
  expect(owned.listenerCount('extension-ui')).toBe(0)
  const started = client(frame, 'started')
  await expect(
    commandLearningCarrier(
      started as unknown as PiRpcClient,
      'job',
      nonce,
      'prepare',
      new AbortController().signal,
    ),
  ).rejects.toThrow('without inference')
  expect(started.killNow).toHaveBeenCalledOnce()
})
it.each([
  { ...frame, nonce: 'b'.repeat(64) },
  { ...frame, jobId: 'other' },
  { ...frame, operation: 'run' },
  'x'.repeat(513),
])('refuses foreign or oversized status frames', async (status) => {
  const owned = client(status)
  await expect(
    commandLearningCarrier(
      owned as unknown as PiRpcClient,
      'job',
      nonce,
      'prepare',
      new AbortController().signal,
    ),
  ).rejects.toThrow()
  expect(owned.listenerCount('event')).toBe(0)
})
