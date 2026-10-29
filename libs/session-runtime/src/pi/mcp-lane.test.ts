import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { RpcCommand } from '@phosphor/shared/rpc'
import type { PiRpcClient } from './rpc-client'
import { controlMcpInLane } from './mcp-lane'

const native = {
  name: 'mcp',
  description: 'Manage MCP [inspection-v1]',
  source: 'extension',
  sourceInfo: { path: 'builtin:mcp', source: 'builtin' },
}
function fixture(command = native, streaming = false) {
  const events = new EventEmitter()
  const request = vi.fn(async (rpc: RpcCommand) => {
    if (rpc.type === 'get_commands') return { success: true, data: { commands: [command] } }
    if (rpc.type === 'get_state')
      return { success: true, data: { isStreaming: streaming, isCompacting: false } }
    if (rpc.type === 'prompt') {
      const words = rpc.message.split(' ')
      const status = (token: string) =>
        events.emit('extension-ui', {
          method: 'setStatus',
          statusKey: 'mcp-inspection',
          statusText: JSON.stringify({
            version: 1,
            requestId: token,
            operation: words[1],
            server: {
              name: words[2],
              state: 'connected',
              tools: [{ name: 'search', description: 'Search incidents', exposure: 'codemode' }],
            },
          }),
        })
      status('not-the-request')
      status(words.at(-1)!)
      return { success: true, data: { disposition: 'handled' } }
    }
    throw new Error('Unexpected command')
  })
  const client = Object.assign(events, { request }) as unknown as Pick<
    PiRpcClient,
    'request' | 'on' | 'off'
  >
  return { client, request, events }
}
it('requires native provenance and capability before ever sending a prompt', async () => {
  for (const command of [
    { ...native, description: 'Old MCP' },
    { ...native, sourceInfo: { path: '/adapter.ts', source: 'local' } },
  ]) {
    const { client, request } = fixture(command)
    expect(await controlMcpInLane(client, 'pagerduty', 'reconnect')).toMatchObject({ ok: false })
    expect(request.mock.calls.map(([rpc]) => rpc.type)).toEqual(['get_commands'])
  }
})
it('reads a correlated native snapshot during streaming without touching state or model', async () => {
  const { client, request, events } = fixture(native, true)
  expect(await controlMcpInLane(client, 'pagerduty', 'inspect')).toMatchObject({
    ok: true,
    report: { name: 'pagerduty', state: 'connected' },
  })
  expect(request.mock.calls.map(([rpc]) => rpc.type)).toEqual([
    'get_commands',
    'prompt',
    'get_state',
  ])
  expect(events.listenerCount('extension-ui')).toBe(0)
})
it('refuses reconnect mid-turn and confirms an idle reconnect through its status', async () => {
  const busy = fixture(native, true)
  expect(await controlMcpInLane(busy.client, 'pagerduty', 'reconnect')).toMatchObject({
    ok: false,
    message: expect.stringContaining('busy'),
  })
  expect(busy.request.mock.calls.some(([rpc]) => rpc.type === 'prompt')).toBe(false)
  const idle = fixture()
  expect(await controlMcpInLane(idle.client, 'pagerduty', 'reconnect')).toMatchObject({
    ok: true,
    report: { state: 'connected' },
  })
  expect(idle.request.mock.calls.find(([rpc]) => rpc.type === 'prompt')?.[0]).toMatchObject({
    message: expect.stringMatching(/^\/mcp reconnect pagerduty --json --request [a-f0-9]+$/),
  })
})
it('does not treat an acknowledged prompt or malformed payload as a successful reconnect', async () => {
  const { client, request, events } = fixture()
  request.mockImplementation(async (rpc) =>
    rpc.type === 'get_commands'
      ? { success: true, data: { commands: [native] } }
      : rpc.type === 'get_state'
        ? { success: true, data: { isStreaming: false, isCompacting: false } }
        : { success: true, data: { disposition: 'handled' } },
  )
  expect(await controlMcpInLane(client, 'pagerduty', 'reconnect')).toMatchObject({ ok: false })
  expect(events.listenerCount('extension-ui')).toBe(0)
})
it('rejects invalid names before touching the native session', async () => {
  const { client, request } = fixture()
  expect(await controlMcpInLane(client, 'x --login', 'inspect')).toMatchObject({ ok: false })
  expect(request).not.toHaveBeenCalled()
})
it('marks stock pi without the inspection capability as unsupported, not a lane failure', async () => {
  const stock = {
    ...native,
    description: 'Manage MCP servers: sign in, reconnect, enable or disable, and change exposure',
  }
  const { client } = fixture(stock)
  expect(await controlMcpInLane(client, 'pagerduty', 'inspect')).toMatchObject({
    ok: false,
    unsupported: true,
  })
})
