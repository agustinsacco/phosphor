import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeadroomProxyProcess, proxyArgs, proxyEnv } from './proxy-process'
import type { Detection } from './proxy-detection'

class ProcessChild extends EventEmitter {
  exitCode: number | null = null
  stderr = new EventEmitter()
  kill = vi.fn(() => true)

  exit(code: number | null): void {
    this.exitCode = code
    this.emit('exit', code)
  }
}

function processRig() {
  const children: ProcessChild[] = []
  const spawnImpl = vi.fn(() => {
    const child = new ProcessChild()
    children.push(child)
    return child as unknown as ChildProcess
  })
  const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
  const quitHandlers: Array<() => void> = []
  const logImpl = vi.fn()
  const detect = vi.fn(async (): Promise<Detection> => ({
    binaryPath: '/bin/headroom',
    version: '0.37.0',
  }))
  const process = new HeadroomProxyProcess(
    {
      spawnImpl: spawnImpl as unknown as typeof spawn,
      fetchImpl: fetchImpl as typeof fetch,
      envImpl: async () => ({ PATH: '/usr/bin' }),
      onWillQuit: (handler) => quitHandlers.push(handler),
      logImpl,
      port: 9876,
    },
    detect,
  )
  return { process, children, spawnImpl, fetchImpl, quitHandlers, logImpl, detect }
}

describe('Headroom owned process', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
  })
  afterEach(() => vi.useRealTimers())

  it('probes loopback health with a bounded signal and never kills an adopted endpoint', async () => {
    const r = processRig()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      expect(await r.process.probe()).toBe(true)
      expect(timeout).toHaveBeenCalledWith(1500)
      expect(r.fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9876/health', {
        signal: expect.any(AbortSignal),
      })
      r.process.killOwned()
      expect(r.process.state.running).toBe(false)
      expect(r.children).toEqual([])
      expect(r.quitHandlers).toEqual([])
    } finally {
      timeout.mockRestore()
    }
  })

  it('keeps a live owned child on non-OK health and fetch errors, but clears health belief', async () => {
    const r = processRig()
    await r.process.startOwned()
    const child = r.process.state.child
    r.fetchImpl.mockResolvedValueOnce(new Response('', { status: 503 }))
    expect(await r.process.probe()).toBe(false)
    expect(r.process.state.running).toBe(false)
    r.fetchImpl.mockRejectedValueOnce(new Error('connection refused'))
    expect(await r.process.probe()).toBe(false)
    expect(r.process.state.child).toBe(child)
    expect(r.children[0]!.kill).not.toHaveBeenCalled()
  })

  it('spawns non-detached with pinned argv/env and resets errors and crashes on health success', async () => {
    const r = processRig()
    r.process.state.crashes = 1
    r.process.state.lastError = 'previous failure'
    await r.process.startOwned()
    expect(r.spawnImpl).toHaveBeenCalledWith('/bin/headroom', proxyArgs(9876), {
      env: proxyEnv({ PATH: '/usr/bin' }),
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    })
    expect(r.process.state.crashes).toBe(0)
    expect(r.process.state.lastError).toBeUndefined()
    expect(r.process.state.running).toBe(true)
  })

  it('ignores exits from a replaced child, including delayed exits after kill', async () => {
    const r = processRig()
    await r.process.startOwned()
    const old = r.children[0]!
    r.process.killOwned()
    await r.process.startOwned()
    const current = r.process.state.child
    old.exit(1)
    expect(r.process.state.child).toBe(current)
    expect(r.process.state.running).toBe(true)
    expect(r.process.state.crashes).toBe(0)
    expect(r.process.state.lastError).toBeUndefined()
    expect(r.logImpl).not.toHaveBeenCalled()
    expect(r.quitHandlers).toHaveLength(1)
    r.quitHandlers[0]!()
    expect(r.children[1]!.kill).toHaveBeenCalledOnce()
  })

  it('clears the matching child on error, recording the message without a crash or exit log', async () => {
    const r = processRig()
    await r.process.startOwned()
    r.children[0]!.emit('error', new Error('spawn failed'))
    expect(r.process.state.child).toBeNull()
    expect(r.process.state.running).toBe(false)
    expect(r.process.state.lastError).toBe('spawn failed')
    r.children[0]!.exit(1)
    expect(r.process.state.crashes).toBe(0)
    expect(r.logImpl).not.toHaveBeenCalled()
  })

  it('preserves replacement ownership on stale errors while retaining existing error and health semantics', async () => {
    const r = processRig()
    await r.process.startOwned()
    const old = r.children[0]!
    r.process.killOwned()
    await r.process.startOwned()
    const current = r.process.state.child
    old.emit('error', new Error('late error'))
    expect(r.process.state.child).toBe(current)
    expect(r.process.state.running).toBe(false)
    expect(r.process.state.lastError).toBe('late error')
  })

  it('caps accumulated stderr at 2000 characters before recording an immediate exit', async () => {
    const r = processRig()
    await r.process.startOwned()
    r.children[0]!.stderr.emit('data', Buffer.from('a'.repeat(1500)))
    r.children[0]!.stderr.emit('data', Buffer.from('b'.repeat(1500)))
    r.children[0]!.exit(7)
    const error = `proxy exited with code 7 after 0 ms: ${'a'.repeat(500)}${'b'.repeat(1500)}`
    expect(r.process.state.lastError).toBe(error)
    expect(r.logImpl).toHaveBeenCalledWith(error)
    expect(r.process.state.crashes).toBe(1)
    expect(r.process.state.child).toBeNull()
  })

  it('reports only the final trimmed stderr line and renders a null exit code', async () => {
    const r = processRig()
    await r.process.startOwned()
    r.children[0]!.stderr.emit('data', Buffer.from('earlier\nfinal error\n'))
    r.children[0]!.exit(null)
    expect(r.process.state.lastError).toBe('proxy exited with code null after 0 ms: final error')
  })

  it('does not count an exit at the ten-second crash-window boundary', async () => {
    const r = processRig()
    await r.process.startOwned()
    r.children[0]!.stderr.emit('data', Buffer.from('ignored on normal exit'))
    vi.setSystemTime(Date.now() + 10_000)
    r.children[0]!.exit(0)
    expect(r.process.state.crashes).toBe(0)
    expect(r.process.state.lastError).toBe('proxy exited with code 0')
    expect(r.logImpl).toHaveBeenCalledWith('proxy exited with code 0')
  })

  it('clears ownership on kill even if kill throws, and does not retry the kill', async () => {
    const r = processRig()
    await r.process.startOwned()
    r.children[0]!.kill.mockImplementationOnce(() => {
      throw new Error('already gone')
    })
    expect(() => r.process.killOwned()).not.toThrow()
    r.process.killOwned()
    expect(r.children[0]!.kill).toHaveBeenCalledOnce()
    expect(r.process.state.child).toBeNull()
    expect(r.process.state.running).toBe(false)
  })

  it('does not signal a child whose exit code is already set', async () => {
    const r = processRig()
    await r.process.startOwned()
    r.children[0]!.exitCode = 0
    r.process.killOwned()
    expect(r.children[0]!.kill).not.toHaveBeenCalled()
    expect(r.process.state.child).toBeNull()
  })

  it('leaves a missing binary or exhausted crash budget unspawned', async () => {
    const r = processRig()
    r.detect.mockResolvedValueOnce({ binaryPath: null, version: null })
    await r.process.startOwned()
    expect(r.process.state.lastError).toBe('headroom is not installed')
    r.process.state.crashes = 2
    await r.process.startOwned()
    expect(r.process.state.lastError).toContain('exited immediately twice')
    expect(r.spawnImpl).not.toHaveBeenCalled()
    expect(r.quitHandlers).toEqual([])
  })
})
