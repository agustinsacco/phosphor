import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { PiRpcClient } from './rpc-client'

const clients: PiRpcClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
})

it('rejects mutations neutrally while allowing reads and interrupts during runtime shutdown', async () => {
  let closing = false
  const client = new PiRpcClient(
    {
      cwd: import.meta.dirname,
      binaryPath: process.execPath,
      prefixArgs: [join(import.meta.dirname, '__fixtures__', 'fake-pi.cjs')],
    },
    { log: vi.fn(), isClosing: () => closing },
  )
  clients.push(client)
  client.spawn()
  expect((await client.request({ type: 'get_state' })).success).toBe(true)
  closing = true
  const rejection = 'Runtime is shutting down. New work cannot start.'
  await expect(client.request({ type: 'prompt', message: 'blocked' })).rejects.toThrow(rejection)
  await expect(client.request({ type: 'set_session_name', name: 'blocked' })).rejects.toThrow(
    rejection,
  )
  expect((await client.request({ type: 'get_state' })).success).toBe(true)
  expect((await client.request({ type: 'abort' })).success).toBe(true)
  // The fixture does not implement these commands, but correlated error responses
  // prove they reached pi rather than being rejected by shutdown admission.
  for (const type of ['abort_bash', 'abort_retry', 'clear_queue'] as const) {
    await expect(client.request({ type })).resolves.toMatchObject({
      command: type,
      success: false,
      error: 'unsupported in fake',
    })
  }
  closing = false
  expect((await client.request({ type: 'prompt', message: 'allowed again' })).success).toBe(true)
})
