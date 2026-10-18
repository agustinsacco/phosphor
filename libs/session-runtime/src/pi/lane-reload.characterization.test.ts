import { describe, expect, it, vi } from 'vitest'
import { LANE_RELOAD_COMMAND, LANE_RELOAD_STATUS_KEY } from '@phosphor/pi-extensions/lane-reload'
import { createLaneReload } from './lane-reload'
import { PiRpcClient } from './rpc-client'

function lane(options: { outcome?: string; supported?: boolean; reject?: boolean } = {}) {
  const client = new PiRpcClient({ cwd: '/repo' }, { log: () => undefined, isClosing: () => false })
  const request = vi.spyOn(client, 'request').mockImplementation(async (command) => {
    if (options.reject) throw new Error('transport stopped')
    if (command.type === 'get_commands') {
      return {
        type: 'response',
        command: command.type,
        success: true,
        data: {
          commands:
            options.supported === false ? [] : [{ name: LANE_RELOAD_COMMAND, source: 'extension' }],
        },
      }
    }
    if (command.type === 'prompt') {
      const token = command.message.split(' ')[1]
      for (const status of [
        { token, outcome: options.outcome ?? 'applied' },
        { token: 'old-request', outcome: 'failed' },
      ]) {
        client.emit('extension-ui', {
          type: 'extension_ui_request',
          id: 'status',
          method: 'setStatus',
          statusKey: LANE_RELOAD_STATUS_KEY,
          statusText: JSON.stringify(status),
        })
      }
    }
    return { type: 'response', command: command.type, success: true }
  })
  return { client, request }
}

function harness() {
  const fingerprint = vi.fn<(cwd: string) => Promise<string | null>>().mockResolvedValue('v1')
  const log = vi.fn()
  const onApplied = vi.fn()
  const reload = createLaneReload({ fingerprint, log, onApplied })
  return { fingerprint, log, onApplied, reload }
}

describe('lane-reload characterization', () => {
  it('captures before spawn and reloads a change made before tracking', async () => {
    const h = harness()
    const captured = await h.reload.capture('/repo')
    h.fingerprint.mockResolvedValue('v2')
    const pi = lane()
    h.reload.track('lane', captured, pi.client)
    expect(await h.reload.beforePrompt('lane', pi.client, '/repo')).toBe('applied')
    expect(pi.request.mock.calls.map(([command]) => command.type)).toEqual([
      'get_commands',
      'prompt',
    ])
    expect(pi.request.mock.calls[1]?.[0]).toMatchObject({
      message: expect.stringMatching(/^\/phosphor-reload [a-f0-9]{16}$/),
    })
    expect(h.onApplied).toHaveBeenCalledExactlyOnceWith('lane')
    expect(pi.client.listenerCount('extension-ui')).toBe(0)
    expect(await h.reload.beforePrompt('lane', pi.client, '/repo')).toBe('unchanged')
  })

  it('never reloads null captures or null current fingerprints, including read failures', async () => {
    const h = harness()
    const pi = lane()
    h.fingerprint.mockResolvedValue(null)
    h.reload.track('unreadable', await h.reload.capture('/repo'), pi.client)
    h.fingerprint.mockResolvedValue('v2')
    expect(await h.reload.beforePrompt('unreadable', pi.client, '/repo')).toBe('unchanged')
    h.reload.track('tracked', 'v1', pi.client)
    h.fingerprint.mockResolvedValue(null)
    expect(await h.reload.beforePrompt('tracked', pi.client, '/repo')).toBe('unchanged')
    h.fingerprint.mockRejectedValue(new Error('unreadable'))
    expect(await h.reload.capture('/repo')).toBeNull()
    expect(await h.reload.beforePrompt('tracked', pi.client, '/repo')).toBe('unchanged')
    expect(pi.request).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledWith('pi', 'lane config fingerprint failed', {
      cwd: '/repo',
      error: 'Error: unreadable',
    })
  })

  it('notices unsupported commands once per fingerprint without sending a prompt', async () => {
    const h = harness()
    const pi = lane({ supported: false })
    h.reload.track('lane', 'v0', pi.client)
    expect(await h.reload.beforePrompt('lane', pi.client, '/repo')).toBe('unsupported')
    expect(await h.reload.beforePrompt('lane', pi.client, '/repo')).toBe('unchanged')
    expect(h.log).toHaveBeenCalledExactlyOnceWith(
      'pi',
      'lane cannot reload; config change waits for a new lane',
      { sessionId: 'lane' },
    )
    h.fingerprint.mockResolvedValue('v2')
    expect(await h.reload.beforePrompt('lane', pi.client, '/repo')).toBe('unsupported')
    expect(pi.request.mock.calls.map(([command]) => command.type)).toEqual([
      'get_commands',
      'get_commands',
    ])
  })

  it.each(['busy', 'failed', 'subagents'])(
    'retries %s without advancing the fingerprint',
    async (outcome) => {
      const h = harness()
      const pi = lane({ outcome })
      h.reload.track('lane', 'v0', pi.client)
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await h.reload.beforePrompt('lane', pi.client, '/repo')).toBe(outcome)
        expect(pi.client.listenerCount('extension-ui')).toBe(0)
      }
      expect(pi.request).toHaveBeenCalledTimes(4)
      expect(h.onApplied).not.toHaveBeenCalled()
    },
  )

  it('contains transport failures and retries them on the next prompt', async () => {
    const h = harness()
    const pi = lane({ reject: true })
    h.reload.track('lane', 'v0', pi.client)
    expect(await h.reload.beforePrompt('lane', pi.client, '/repo')).toBe('failed')
    expect(await h.reload.beforePrompt('lane', pi.client, '/repo')).toBe('failed')
    expect(pi.request).toHaveBeenCalledTimes(2)
    expect(h.log).toHaveBeenCalledWith('pi', 'lane reload failed', {
      sessionId: 'lane',
      error: 'Error: transport stopped',
    })
  })
})
