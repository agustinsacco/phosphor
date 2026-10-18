import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHeadroomSupervisor, HEADROOM_PROXY_URL } from './proxy'

class CharacterizationChild extends EventEmitter {
  exitCode: number | null = null
  stderr = new EventEmitter()
  kill = vi.fn(() => {
    this.exitCode = 0
    queueMicrotask(() => this.emit('exit', 0))
    return true
  })

  crash(): void {
    this.exitCode = 1
    this.emit('exit', 1)
  }
}

function supervisorRig(
  options: { healthy?: boolean; healOnSpawn?: boolean; crash?: boolean } = {},
) {
  const endpoint = { healthy: options.healthy ?? false }
  const enabled = { value: true }
  const children: CharacterizationChild[] = []
  const quitHandlers: Array<() => void> = []
  const spawnImpl = vi.fn(() => {
    const child = new CharacterizationChild()
    children.push(child)
    if (options.crash) queueMicrotask(() => child.crash())
    else if (options.healOnSpawn ?? true) endpoint.healthy = true
    return child as unknown as ChildProcess
  }) as unknown as typeof spawn
  const fetchImpl = vi.fn(async () => new Response('', { status: endpoint.healthy ? 200 : 503 }))
  const supervisor = createHeadroomSupervisor({
    fetchImpl: fetchImpl as typeof fetch,
    spawnImpl,
    resolveBinaryImpl: async () => '/bin/headroom',
    versionImpl: async () => '0.37.0',
    envImpl: async () => ({ PATH: '/usr/bin' }),
    onWillQuit: (handler) => quitHandlers.push(handler),
    isEnabled: () => enabled.value,
    setEnabled: (value) => {
      enabled.value = value
    },
    logImpl: vi.fn(),
  })
  return { supervisor, endpoint, children, quitHandlers, spawnImpl, fetchImpl }
}

describe('Headroom supervisor lifecycle characterization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
  })
  afterEach(() => vi.useRealTimers())

  it('adopts a healthy external proxy without spawning or killing it on stop, disable or quit', async () => {
    const r = supervisorRig({ healthy: true })
    await r.supervisor.ensure()
    expect((await r.supervisor.status()).proxy).toEqual({
      running: true,
      owned: false,
      url: HEADROOM_PROXY_URL,
    })
    expect((await r.supervisor.stop()).proxy.running).toBe(true)
    expect((await r.supervisor.setEnabled(false)).proxy.running).toBe(true)
    expect(r.spawnImpl).not.toHaveBeenCalled()
    expect(r.quitHandlers).toEqual([])
    expect(r.supervisor.sessionEnv()).toEqual({})
  })

  it('cleans up only its owned child on quit and registers the quit hook once', async () => {
    const r = supervisorRig()
    await r.supervisor.ensure()
    expect((await r.supervisor.status()).proxy.owned).toBe(true)
    expect(r.spawnImpl).toHaveBeenCalledWith('/bin/headroom', expect.any(Array), {
      env: expect.objectContaining({ PATH: '/usr/bin', HEADROOM_HOST: '127.0.0.1' }),
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    })
    r.quitHandlers[0]!()
    expect(r.children[0]!.kill).toHaveBeenCalledOnce()
    r.endpoint.healthy = false
    await r.supervisor.ensure()
    expect(r.children).toHaveLength(2)
    expect(r.quitHandlers).toHaveLength(1)
    await r.supervisor.setEnabled(false)
    expect(r.children[1]!.kill).toHaveBeenCalledOnce()
  })

  it('stops retries after two immediate crashes and lets a human start reset the budget', async () => {
    const r = supervisorRig({ crash: true })
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = r.supervisor.ensure()
      await vi.runAllTimersAsync()
      await pending
    }
    expect(r.children).toHaveLength(2)
    expect((await r.supervisor.status()).error).toBe(
      'the proxy exited immediately twice; start it manually to see why',
    )
    const pending = r.supervisor.start()
    await vi.runAllTimersAsync()
    await pending
    expect(r.children).toHaveLength(3)
  })

  it('lets a human enable reset the immediate-crash budget', async () => {
    const r = supervisorRig({ crash: true })
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = r.supervisor.ensure()
      await vi.runAllTimersAsync()
      await pending
    }
    const pending = r.supervisor.setEnabled(true)
    await vi.runAllTimersAsync()
    await pending
    expect(r.children).toHaveLength(3)
  })

  it('kills an unresponsive owned child at the startup deadline and reports the error', async () => {
    const r = supervisorRig({ healOnSpawn: false })
    const pending = r.supervisor.ensure()
    await vi.advanceTimersByTimeAsync(14_800)
    expect(r.children[0]!.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)
    await pending
    expect(r.children[0]!.kill).toHaveBeenCalledOnce()
    expect((await r.supervisor.status()).error).toBe(
      'proxy did not answer /health within the startup deadline',
    )
    expect(r.supervisor.sessionEnv()).toEqual({})
    await vi.runAllTimersAsync()
  })

  it('single-flights concurrent ensures into one owned child', async () => {
    const r = supervisorRig()
    await Promise.all([r.supervisor.ensure(), r.supervisor.ensure(), r.supervisor.ensure()])
    expect(r.children).toHaveLength(1)
    expect((await r.supervisor.status()).proxy.owned).toBe(true)
  })

  it('reads current health belief synchronously for session env while healing in the background', async () => {
    const r = supervisorRig()
    expect(r.supervisor.sessionEnv()).toEqual({})
    await r.supervisor.ensure()
    r.endpoint.healthy = false
    expect(r.supervisor.sessionEnv()).toEqual({ PHOSPHOR_HEADROOM_URL: HEADROOM_PROXY_URL })
    await r.supervisor.ensure()
    await r.supervisor.setEnabled(false)
    expect(r.supervisor.sessionEnv()).toEqual({})
  })
})
