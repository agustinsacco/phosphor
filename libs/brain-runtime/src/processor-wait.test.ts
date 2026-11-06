import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import { promptProcessor } from './processor-wait'

it('never sends an inference prompt when cancellation preceded the prompt step', async () => {
  const request = vi.fn(async () => ({ success: true }))
  const client = Object.assign(new EventEmitter(), { request })
  const live = { client } as unknown as LiveSession
  const abort = new AbortController()
  abort.abort(new Error('Cancelled before prompt'))
  await expect(promptProcessor(live, 'Do not run', abort.signal)).rejects.toThrow('Cancelled')
  expect(request).not.toHaveBeenCalled()
  expect(client.listenerCount('event')).toBe(0)
})
