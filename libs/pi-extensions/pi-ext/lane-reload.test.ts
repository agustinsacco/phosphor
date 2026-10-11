import { describe, expect, it } from 'vitest'
import laneReload, {
  LANE_RELOAD_COMMAND,
  LANE_RELOAD_STATUS_KEY,
  ensureLivenessRegistry,
  hasLiveWork,
} from './lane-reload'

const REGISTRY = Symbol.for('@agegr/pi-web/session-liveness/v1')

/**
 * One pi process: `slots` stands in for globalThis, which outlives a reload,
 * and every reload loads the extension again into a fresh runtime.
 */
function fakeLane(options: { idle?: boolean; reloadFails?: boolean } = {}) {
  const slots = {}
  const statuses: Array<{ token: string; outcome: string }> = []
  const ui = {
    setStatus: (key: string, text: string | undefined) => {
      if (key === LANE_RELOAD_STATUS_KEY && text) statuses.push(JSON.parse(text))
    },
  }
  let runtime = load()
  let loads = 1

  function load() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    let command: ((args: string, ctx: never) => Promise<void>) | undefined
    laneReload(
      {
        on: (event, handler) => void handlers.set(event, handler),
        registerCommand: (name, spec) => {
          if (name === LANE_RELOAD_COMMAND) command = spec.handler
        },
      },
      slots,
    )
    return { handlers, command: command! }
  }

  const ctx = {
    isIdle: () => options.idle ?? true,
    sessionManager: { getSessionId: () => 's1' },
    ui,
    reload: async () => {
      if (options.reloadFails) throw new Error('boom')
      runtime = load()
      loads++
      await runtime.handlers.get('session_start')?.({ reason: 'reload' }, { ui })
    },
  }

  return {
    slots,
    statuses,
    loads: () => loads,
    send: (args: string) => runtime.command(args, ctx as never),
    start: (reason: string) => runtime.handlers.get('session_start')?.({ reason }, { ui }),
  }
}

describe('lane reload command', () => {
  it('reloads an idle lane and reports it from the new runtime', async () => {
    const lane = fakeLane()
    await lane.send('t1')
    expect(lane.loads()).toBe(2)
    expect(lane.statuses).toEqual([{ token: 't1', outcome: 'applied' }])
  })

  it('refuses a lane mid-run without reloading', async () => {
    const lane = fakeLane({ idle: false })
    await lane.send('t1')
    expect(lane.loads()).toBe(1)
    expect(lane.statuses).toEqual([{ token: 't1', outcome: 'busy' }])
  })

  it('waits while sub-agent work is live, and goes ahead once it is not', async () => {
    const lane = fakeLane()
    const registry = ensureLivenessRegistry(lane.slots)!
    let active = true
    const release = registry.register({
      name: 'pi-subagents',
      sessionId: 's1',
      isActive: () => active,
    })
    registry.register({ name: 'pi-subagents', sessionId: 'other', isActive: () => true })
    await lane.send('t1')
    expect(lane.statuses.at(-1)).toEqual({ token: 't1', outcome: 'subagents' })
    active = false
    await lane.send('t2')
    expect(lane.statuses.at(-1)).toEqual({ token: 't2', outcome: 'applied' })
    release()
  })

  it('says when the reload itself failed', async () => {
    const lane = fakeLane({ reloadFails: true })
    await lane.send('t1')
    expect(lane.statuses).toEqual([{ token: 't1', outcome: 'failed' }])
  })

  it('does not claim a reload it did not ask for', async () => {
    const lane = fakeLane()
    await lane.start('reload')
    await lane.start('startup')
    expect(lane.statuses).toEqual([])
  })

  it('rejects a malformed token', async () => {
    await expect(fakeLane().send('a b')).rejects.toThrow(/Invalid/)
  })
})

describe('liveness registry', () => {
  it('keeps one registry across reloads and reads only its own', () => {
    const slots = {}
    const first = ensureLivenessRegistry(slots)
    expect(ensureLivenessRegistry(slots)).toBe(first)
    const foreign = { [REGISTRY]: { version: 1, register: () => () => undefined } }
    expect(ensureLivenessRegistry(foreign)).toBeNull()
    // Unreadable means unknown, and unknown never clears a lane.
    expect(hasLiveWork(null, 's1')).toBe(true)
  })

  it('treats a provider that throws as live', () => {
    const registry = ensureLivenessRegistry({})!
    registry.register({
      sessionId: 's1',
      isActive: () => {
        throw new Error('stale')
      },
    })
    expect(hasLiveWork(registry, 's1')).toBe(true)
    expect(hasLiveWork(registry, 's2')).toBe(false)
  })
})
