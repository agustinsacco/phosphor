import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { LANE_RELOAD_COMMAND, LANE_RELOAD_STATUS_KEY } from '@phosphor/pi-extensions/lane-reload'
import type { RpcCommand } from '@shared/rpc'
import { createLaneReload } from './lane-reload'

/** A pi that answers the reload command by publishing `outcome` first, as the extension does. */
function fakeClient(options: { outcome?: string; hasCommand?: boolean; fail?: boolean } = {}) {
  const emitter = new EventEmitter()
  const sent: RpcCommand[] = []
  const request = vi.fn(async (command: RpcCommand) => {
    sent.push(command)
    if (options.fail) throw new Error('pi process is not running')
    if (command.type === 'get_commands') {
      const commands = options.hasCommand === false ? [] : [{ name: LANE_RELOAD_COMMAND }]
      return { success: true, data: { commands } }
    }
    if (command.type === 'prompt' && options.outcome) {
      const token = command.message.split(' ')[1]
      emitter.emit('extension-ui', {
        type: 'extension_ui_request',
        id: 'x',
        method: 'setStatus',
        statusKey: LANE_RELOAD_STATUS_KEY,
        statusText: JSON.stringify({ token, outcome: options.outcome }),
      })
      // A stale status from an earlier request must not count.
      emitter.emit('extension-ui', {
        type: 'extension_ui_request',
        id: 'y',
        method: 'setStatus',
        statusKey: LANE_RELOAD_STATUS_KEY,
        statusText: JSON.stringify({ token: 'old', outcome: 'applied' }),
      })
    }
    return { success: true }
  })
  const client = {
    request,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  } as never
  return { client, sent, emitter }
}

function harness(initial = 'v1') {
  let current: string | null = initial
  const onApplied = vi.fn()
  const reload = createLaneReload({
    fingerprint: async () => current,
    log: () => undefined,
    onApplied,
  })
  return {
    reload,
    onApplied,
    set: (value: string | null) => {
      current = value
    },
  }
}

async function tracked(h: ReturnType<typeof harness>, client: never) {
  h.reload.track('s1', await h.reload.capture('/repo'), client)
}

describe('lane reload', () => {
  it('does nothing, and asks pi nothing, while the config is unchanged', async () => {
    const h = harness()
    const lane = fakeClient({ outcome: 'applied' })
    await tracked(h, lane.client)
    expect(await h.reload.beforePrompt('s1', lane.client, '/repo')).toBe('unchanged')
    expect(lane.sent).toEqual([])
  })

  it('reloads once after a change and then settles on the new config', async () => {
    const h = harness()
    const lane = fakeClient({ outcome: 'applied' })
    await tracked(h, lane.client)
    h.set('v2')
    expect(await h.reload.beforePrompt('s1', lane.client, '/repo')).toBe('applied')
    expect(lane.sent.map((c) => c.type)).toEqual(['get_commands', 'prompt'])
    expect(lane.sent[1]).toMatchObject({
      message: expect.stringMatching(/^\/phosphor-reload \w+$/),
    })
    expect(h.onApplied).toHaveBeenCalledWith('s1')
    expect(await h.reload.beforePrompt('s1', lane.client, '/repo')).toBe('unchanged')
    expect(lane.emitter.listenerCount('extension-ui')).toBe(0)
  })

  it('tries again on the next prompt when pi refused or never answered', async () => {
    for (const outcome of ['subagents', 'busy', undefined]) {
      const h = harness()
      const lane = fakeClient({ outcome })
      await tracked(h, lane.client)
      h.set('v2')
      expect(await h.reload.beforePrompt('s1', lane.client, '/repo')).toBe(outcome ?? 'failed')
      expect(h.onApplied).not.toHaveBeenCalled()
      lane.sent.length = 0
      await h.reload.beforePrompt('s1', lane.client, '/repo')
      expect(lane.sent.map((c) => c.type)).toEqual(['get_commands', 'prompt'])
    }
  })

  it('never sends the command to a pi that lacks it, where it would reach the model', async () => {
    const h = harness()
    const lane = fakeClient({ hasCommand: false })
    await tracked(h, lane.client)
    h.set('v2')
    expect(await h.reload.beforePrompt('s1', lane.client, '/repo')).toBe('unsupported')
    expect(lane.sent.map((c) => c.type)).toEqual(['get_commands'])
    // Not asked again until the config changes again.
    expect(await h.reload.beforePrompt('s1', lane.client, '/repo')).toBe('unchanged')
  })

  it('never reloads an untracked lane or one whose config cannot be read, and never throws', async () => {
    const h = harness()
    const lane = fakeClient({ outcome: 'applied' })
    expect(await h.reload.beforePrompt('s1', lane.client, '/repo')).toBe('unchanged')
    await tracked(h, lane.client)
    h.set(null)
    expect(await h.reload.beforePrompt('s1', lane.client, '/repo')).toBe('unchanged')
    const dead = fakeClient({ fail: true })
    h.set('v3')
    expect(await h.reload.beforePrompt('s1', dead.client, '/repo')).toBe('failed')
  })

  it('forgets a lane when its process exits', async () => {
    const h = harness()
    const lane = fakeClient({ outcome: 'applied' })
    await tracked(h, lane.client)
    lane.emitter.emit('exit', { code: 0, signal: null, expected: true })
    h.set('v2')
    expect(await h.reload.beforePrompt('s1', lane.client, '/repo')).toBe('unchanged')
  })
})
