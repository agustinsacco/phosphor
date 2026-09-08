import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createHeadroomSupervisor, HEADROOM_PROXY_URL, proxyArgs, proxyEnv } from './proxy'

/**
 * The supervisor's promises are lifecycle SAFETY properties, not features:
 * adopt-never-duplicate, one spawn per race, no restart loops, owned-only
 * kills. Each gets a test because each was a real incident mode upstream
 * (their own self-heal hook exists because unclean proxy exits bricked
 * `claude` for their users).
 */

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  killed = false
  stderr = new EventEmitter()
  kill(): boolean {
    this.killed = true
    this.exitCode = 0
    this.emit('exit', 0)
    return true
  }
}

interface Rig {
  supervisor: ReturnType<typeof createHeadroomSupervisor>
  spawns: FakeChild[]
  setHealthy: (healthy: boolean) => void
  enabled: { value: boolean }
  quitHandlers: Array<() => void>
}

function rig(options: { healthy?: boolean; installed?: boolean; enabled?: boolean } = {}): Rig {
  let healthy = options.healthy ?? false
  const spawns: FakeChild[] = []
  const enabled = { value: options.enabled ?? true }
  const quitHandlers: Array<() => void> = []

  const supervisor = createHeadroomSupervisor({
    fetchImpl: (async () =>
      healthy
        ? new Response('{"status":"ok"}')
        : Promise.reject(new Error('down'))) as typeof fetch,
    spawnImpl: ((): FakeChild => {
      const child = new FakeChild()
      spawns.push(child)
      // A successful spawn makes the proxy healthy on the next poll.
      setTimeout(() => {
        if (child.exitCode === null) healthy = true
      }, 0)
      return child
    }) as never,
    resolveBinaryImpl: async () => ((options.installed ?? true) ? '/fake/bin/headroom' : null),
    envImpl: async () => ({ PATH: '/usr/bin' }),
    versionImpl: async () => '0.37.0',
    onWillQuit: (handler) => quitHandlers.push(handler),
    isEnabled: () => enabled.value,
    setEnabled: (value) => {
      enabled.value = value
    },
    logImpl: () => undefined,
  })

  return {
    supervisor,
    spawns,
    setHealthy: (value) => {
      healthy = value
    },
    enabled,
    quitHandlers,
  }
}

describe('spawn contract', () => {
  it('pins privacy and lossless compressors in env, loopback and no-subscription-tracking in argv', () => {
    const env = proxyEnv({ PATH: '/usr/bin', HEADROOM_HOST: '0.0.0.0' })
    expect(env.HEADROOM_BEACON).toBe('off')
    expect(env.DO_NOT_TRACK).toBe('1')
    expect(env.HEADROOM_UPDATE_CHECK).toBe('off')
    expect(env.HEADROOM_COMPRESSORS).toBe('smart_crusher,tabular')
    // A user-profile HEADROOM_HOST must not widen the bind.
    expect(env.HEADROOM_HOST).toBe('127.0.0.1')

    const args = proxyArgs()
    expect(args).toContain('--no-subscription-tracking')
    expect(args.join(' ')).toContain('--host 127.0.0.1')
  })
})

describe('adoption and spawning', () => {
  it('adopts an already-healthy proxy and never spawns a second', async () => {
    const r = rig({ healthy: true })
    await r.supervisor.ensure()
    const status = await r.supervisor.status()
    expect(r.spawns).toHaveLength(0)
    expect(status.proxy.running).toBe(true)
    expect(status.proxy.owned).toBe(false)
  })

  it('spawns when the port is silent, and reports the proxy as owned', async () => {
    const r = rig({ healthy: false })
    await r.supervisor.ensure()
    const status = await r.supervisor.status()
    expect(r.spawns).toHaveLength(1)
    expect(status.proxy.running).toBe(true)
    expect(status.proxy.owned).toBe(true)
  })

  it('single-flights concurrent ensures into one spawn', async () => {
    const r = rig({ healthy: false })
    await Promise.all([r.supervisor.ensure(), r.supervisor.ensure(), r.supervisor.ensure()])
    expect(r.spawns).toHaveLength(1)
  })

  it('does nothing while disabled', async () => {
    const r = rig({ healthy: false, enabled: false })
    await r.supervisor.ensure()
    expect(r.spawns).toHaveLength(0)
    expect(r.supervisor.sessionEnv()).toEqual({})
  })

  it('reports not-installed instead of spawning when the binary is missing', async () => {
    const r = rig({ healthy: false, installed: false })
    await r.supervisor.ensure()
    const status = await r.supervisor.status()
    expect(r.spawns).toHaveLength(0)
    expect(status.installed).toBe(false)
    expect(status.error).toContain('not installed')
  })
})

describe('crash guard', () => {
  it('stops auto-starting after two immediate exits, until a human start resets it', async () => {
    const r = rig({ healthy: false })
    // Break the fake spawn's self-heal: children die immediately instead.
    const dieFast = (): void => {
      const child = r.spawns[r.spawns.length - 1]!
      child.exitCode = 1
      child.emit('exit', 1)
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = r.supervisor.ensure()
      // Let the spawn land, then crash it before health ever answers.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (r.spawns.length > attempt) dieFast()
      r.setHealthy(false)
      await pending
    }
    // Two crashes spent the budget; the third ensure refused to spawn.
    expect(r.spawns).toHaveLength(2)
    const status = await r.supervisor.status()
    expect(status.error).toContain('twice')

    // An explicit user start gets a fresh budget.
    r.setHealthy(false)
    const startPromise = r.supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.spawns).toHaveLength(3)
    r.setHealthy(true)
    await startPromise
  })
})

describe('ownership', () => {
  it('setEnabled(false) kills an owned proxy', async () => {
    const r = rig({ healthy: false })
    await r.supervisor.ensure()
    expect(r.spawns).toHaveLength(1)
    r.setHealthy(false) // the real child's death takes the endpoint down
    const status = await r.supervisor.setEnabled(false)
    expect(r.spawns[0]!.killed).toBe(true)
    expect(status.enabled).toBe(false)
    expect(status.proxy.owned).toBe(false)
  })

  it('setEnabled(false) leaves an adopted proxy alone', async () => {
    const r = rig({ healthy: true })
    await r.supervisor.ensure()
    const status = await r.supervisor.setEnabled(false)
    expect(r.spawns).toHaveLength(0)
    // Adopted proxy still up — Phosphor just stops pointing sessions at it.
    expect(status.proxy.running).toBe(true)
    expect(r.supervisor.sessionEnv()).toEqual({})
  })

  it('kills the owned proxy on app quit', async () => {
    const r = rig({ healthy: false })
    await r.supervisor.ensure()
    expect(r.quitHandlers).toHaveLength(1)
    r.quitHandlers[0]!()
    expect(r.spawns[0]!.killed).toBe(true)
  })
})

describe('sessionEnv', () => {
  it('hands the URL to new sessions only while the proxy is believed running', async () => {
    const r = rig({ healthy: false })
    expect(r.supervisor.sessionEnv()).toEqual({})
    await r.supervisor.ensure()
    expect(r.supervisor.sessionEnv()).toEqual({ PHOSPHOR_HEADROOM_URL: HEADROOM_PROXY_URL })
  })

  it('self-heals in the background after a stale miss', async () => {
    vi.useRealTimers()
    const r = rig({ healthy: false })
    // First call: not running yet → no env, but ensure() was kicked off.
    expect(r.supervisor.sessionEnv()).toEqual({})
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.spawns.length).toBeGreaterThan(0)
  })
})
