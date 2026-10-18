import { readdir } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { identityDirectory } from '../control/identity'
import type { HostStore } from '../lanes/store'
import { runHost } from './run'
import { createRunFixture, deferred, heartbeatBarrier, waitForRunEvent } from './__fixtures__/run'

afterEach(() => {
  vi.useRealTimers()
})

describe('run harness', () => {
  it('publishes running only after its transport can be cancelled and acknowledges stopping', async () => {
    const heartbeat = heartbeatBarrier()
    const controller = new AbortController()
    const request = heartbeat.fetch('https://example.com', {
      body: JSON.stringify({ state: 'running' }),
      signal: controller.signal,
    })
    const rejected = expect(request).rejects.toThrow('cancelled')
    await heartbeat.running
    expect(heartbeat.states).toEqual(['running'])
    controller.abort()
    await rejected
    const stopping = await heartbeat.fetch('https://example.com', {
      body: JSON.stringify({ state: 'stopping' }),
    })
    expect(await stopping.json()).toEqual({ accepted: true, nextInSec: 30 })
    expect(heartbeat.states).toEqual(['running', 'stopping'])
  })

  it('keeps a release barrier held until explicitly resumed', async () => {
    const reached = deferred()
    const resume = deferred()
    const events: string[] = []
    const releasing = (async () => {
      reached.resolve()
      await resume.promise
      events.push('released')
    })()
    await reached.promise
    expect(events).toEqual([])
    resume.resolve()
    await releasing
    expect(events).toEqual(['released'])
  })

  it('reports failed initialization only after the real store closes and run lock is released', async () => {
    const fixture = await createRunFixture()
    let opened: HostStore | undefined
    try {
      await fixture.machine.enrollOld()
      const run = runHost({
        ...fixture.context(),
        reconcile: async (store) => {
          opened = store
          throw new Error('private initialization failure')
        },
      })
      await expect(waitForRunEvent(deferred().promise, run)).rejects.toThrow('exit 70')
      expect(opened).toBeDefined()
      expect(() => opened?.listLanes()).toThrow(/closed|not open/)
      expect(
        (await readdir(identityDirectory(fixture.machine.configPath))).filter((name) =>
          name.startsWith('.run-lock'),
        ),
      ).toEqual([])
      expect(fixture.machine.output.join('\n')).not.toContain('private initialization failure')
    } finally {
      await fixture.machine.cleanup()
    }
  })

  it('disposes the timeout when the awaited event arrives', async () => {
    vi.useFakeTimers()
    const event = deferred()
    const waiting = waitForRunEvent(event.promise, new Promise<number>(() => {}))
    expect(vi.getTimerCount()).toBe(1)
    event.resolve()
    await waiting
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposes the timeout and preserves an initialization rejection', async () => {
    vi.useFakeTimers()
    const failure = new Error('initialization rejected')
    await expect(waitForRunEvent(deferred().promise, Promise.reject(failure))).rejects.toBe(failure)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposes the timeout when run ends before the event', async () => {
    vi.useFakeTimers()
    await expect(waitForRunEvent(deferred().promise, Promise.resolve(78))).rejects.toThrow(
      'exit 78',
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a missing event and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const waiting = waitForRunEvent(deferred().promise, new Promise<number>(() => {}), 100)
    const rejected = expect(waiting).rejects.toThrow('Timed out waiting for Host event')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
})
