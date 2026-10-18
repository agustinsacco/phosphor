import { describe, expect, it, vi } from 'vitest'
import { LANE_RELOAD_COMMAND, LANE_RELOAD_STATUS_KEY } from '@phosphor/pi-extensions/lane-reload'
import type { RpcResponse } from '@shared/rpc'
import { createLaneReload } from './lane-reload'
import { PiRpcClient } from './rpc-client'

function harness() {
  const client = new PiRpcClient({ cwd: '/repo' }, { log: () => undefined, isClosing: () => false })
  const request = vi.spyOn(client, 'request').mockResolvedValue({
    type: 'response',
    command: 'prompt',
    success: true,
  })
  const fingerprint = vi.fn<(cwd: string) => Promise<string | null>>().mockResolvedValue('v2')
  const onApplied = vi.fn()
  const log = vi.fn()
  const reload = createLaneReload({ fingerprint, onApplied, log })
  reload.track('lane', 'v1', client)
  const status = (statusText?: string, statusKey = LANE_RELOAD_STATUS_KEY) => {
    client.emit('extension-ui', {
      type: 'extension_ui_request',
      id: 'status',
      method: 'setStatus',
      statusKey,
      statusText,
    })
  }
  const admit = () =>
    request.mockResolvedValueOnce({
      type: 'response',
      command: 'get_commands',
      success: true,
      data: { commands: [{ name: LANE_RELOAD_COMMAND, source: 'extension' }] },
    })
  return { client, request, fingerprint, onApplied, log, reload, status, admit }
}

function deferredResponse() {
  let resolve!: (response: RpcResponse<undefined>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<RpcResponse<undefined>>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('lane-reload steps', () => {
  it('listens before sending and waits for the RPC response before applying a matching status', async () => {
    const h = harness()
    const pending = deferredResponse()
    const entered = deferredResponse()
    h.admit().mockImplementationOnce((command) => {
      if (command.type !== 'prompt') throw new Error('expected reload prompt')
      expect(h.client.listenerCount('extension-ui')).toBe(1)
      h.status(JSON.stringify({ token: command.message.split(' ')[1], outcome: 'applied' }))
      entered.resolve({ type: 'response', command: 'prompt', success: true })
      return pending.promise
    })
    const result = h.reload.beforePrompt('lane', h.client, '/repo')
    await entered.promise
    expect(h.onApplied).not.toHaveBeenCalled()
    expect(h.client.listenerCount('extension-ui')).toBe(1)
    pending.resolve({ type: 'response', command: 'prompt', success: true })
    expect(await result).toBe('applied')
    expect(h.onApplied).toHaveBeenCalledExactlyOnceWith('lane')
    expect(h.client.listenerCount('extension-ui')).toBe(0)
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('unchanged')
  })

  it('ignores malformed JSON, foreign tokens, missing status and unrelated status methods and keys', async () => {
    const h = harness()
    h.admit().mockImplementationOnce(async (command) => {
      if (command.type !== 'prompt') throw new Error('expected reload prompt')
      const matching = JSON.stringify({ token: command.message.split(' ')[1], outcome: 'applied' })
      h.client.emit('extension-ui', {
        type: 'extension_ui_request',
        id: 'notice',
        method: 'notify',
        message: matching,
      })
      h.status(matching, 'other-key')
      for (const text of [
        undefined,
        '{broken',
        'null',
        '{}',
        JSON.stringify({ token: 'foreign', outcome: 'applied' }),
      ]) {
        h.status(text)
      }
      return { type: 'response', command: 'prompt', success: true }
    })
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('failed')
    expect(h.onApplied).not.toHaveBeenCalled()
    expect(h.client.listenerCount('extension-ui')).toBe(0)
    h.admit()
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('failed')
    expect(h.request).toHaveBeenCalledTimes(4)
  })

  it('removes only its own listener when a prompt request rejects, and retries', async () => {
    const h = harness()
    const observer = vi.fn()
    h.client.on('extension-ui', observer)
    h.admit().mockImplementationOnce(async () => {
      expect(h.client.listenerCount('extension-ui')).toBe(2)
      throw new Error('prompt transport failed')
    })
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('failed')
    expect(h.client.listeners('extension-ui')).toEqual([observer])
    expect(h.onApplied).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledWith('pi', 'lane reload failed', {
      sessionId: 'lane',
      error: 'Error: prompt transport failed',
    })
    h.admit().mockRejectedValueOnce(new Error('still stopped'))
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('failed')
    expect(h.request).toHaveBeenCalledTimes(4)
    expect(h.client.listeners('extension-ui')).toEqual([observer])
  })

  it('lets an unsuccessful response override an applied status without advancing state', async () => {
    const h = harness()
    h.admit().mockImplementationOnce(async (command) => {
      if (command.type !== 'prompt') throw new Error('expected reload prompt')
      h.status(JSON.stringify({ token: command.message.split(' ')[1], outcome: 'applied' }))
      return { type: 'response', command: 'prompt', success: false, error: 'refused' }
    })
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('failed')
    expect(h.onApplied).not.toHaveBeenCalled()
    expect(h.client.listenerCount('extension-ui')).toBe(0)
    h.admit()
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('failed')
    expect(h.request).toHaveBeenCalledTimes(4)
  })

  it('never sends a prompt after unsuccessful command discovery and retries discovery', async () => {
    const h = harness()
    h.request.mockResolvedValue({
      type: 'response',
      command: 'get_commands',
      success: false,
      error: 'discovery failed',
    })
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('failed')
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('failed')
    expect(h.request.mock.calls.map(([command]) => command.type)).toEqual([
      'get_commands',
      'get_commands',
    ])
    expect(h.client.listenerCount('extension-ui')).toBe(0)
    expect(h.onApplied).not.toHaveBeenCalled()
  })

  it('treats missing command data as unsupported, not as permission to send a prompt', async () => {
    const h = harness()
    h.request.mockResolvedValue({ type: 'response', command: 'get_commands', success: true })
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('unsupported')
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('unchanged')
    expect(h.request.mock.calls.map(([command]) => command.type)).toEqual(['get_commands'])
  })

  it('forgets only the exited lane and keeps state isolated between factories', async () => {
    const h = harness()
    const other = harness()
    const sibling = new PiRpcClient(
      { cwd: '/repo' },
      { log: () => undefined, isClosing: () => false },
    )
    h.reload.track('sibling', 'v1', sibling)
    h.client.emit('exit', { code: 0, signal: null, expected: true })
    const reads = h.fingerprint.mock.calls.length
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('unchanged')
    expect(h.fingerprint).toHaveBeenCalledTimes(reads)
    expect(h.request).not.toHaveBeenCalled()
    other.admit()
    expect(await other.reload.beforePrompt('lane', other.client, '/repo')).toBe('failed')
    h.admit()
    expect(await h.reload.beforePrompt('sibling', h.client, '/repo')).toBe('failed')
    expect(h.request).toHaveBeenCalledTimes(2)
  })

  it('contains an onApplied error after recording the successful reload', async () => {
    const h = harness()
    h.onApplied.mockImplementation(() => {
      throw new Error('cache callback failed')
    })
    h.admit().mockImplementationOnce(async (command) => {
      if (command.type !== 'prompt') throw new Error('expected reload prompt')
      h.status(JSON.stringify({ token: command.message.split(' ')[1], outcome: 'applied' }))
      return { type: 'response', command: 'prompt', success: true }
    })
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('failed')
    expect(h.onApplied).toHaveBeenCalledExactlyOnceWith('lane')
    expect(await h.reload.beforePrompt('lane', h.client, '/repo')).toBe('unchanged')
    expect(h.client.listenerCount('extension-ui')).toBe(0)
  })
})
