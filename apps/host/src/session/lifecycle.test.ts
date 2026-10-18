import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import type * as PromiseTimers from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDrain,
  createLifecycle,
  isGone,
  trackProcessGroups,
  type DrainTimings,
  type HostState,
} from './lifecycle'

// Node's promise timers otherwise bypass Vitest's virtual clock. OS tests still use real timers.
vi.mock('node:timers/promises', async (importOriginal) => {
  const original = await importOriginal<typeof PromiseTimers>()
  return {
    ...original,
    setTimeout: (ms: number, value?: unknown, options?: { ref?: boolean }) =>
      vi.isFakeTimers()
        ? new Promise((resolve) => setTimeout(() => resolve(value), ms))
        : original.setTimeout(ms, value, options),
  }
})

const FAST: DrainTimings = { abortMs: 200, graceMs: 50, deadlineMs: 2000, settleMs: 20 }
const end = { type: 'agent_end', messages: [] }

/** A pi the test scripts: what get_state says, and how abort and dispose behave. */
class FakeClient extends EventEmitter {
  alive = true
  readonly calls: string[] = []
  constructor(
    private readonly script: {
      streaming?: boolean
      endsOnAbort?: boolean
      endsBeforeState?: boolean
      disposeHangs?: boolean
    } = {},
  ) {
    super()
  }
  async request(command: { type: string }) {
    this.calls.push(command.type)
    if (command.type === 'get_state') {
      // The turn ends while the (now stale) state is on its way.
      if (this.script.endsBeforeState) this.emit('event', end)
      return { success: true, data: { isStreaming: Boolean(this.script.streaming) } }
    }
    if (this.script.endsOnAbort) setTimeout(() => this.emit('event', end), 5)
    return { success: true }
  }
  dispose(graceMs: number) {
    this.calls.push(`dispose ${graceMs}`)
    if (this.script.disposeHangs) return new Promise<void>(() => {})
    this.alive = false
    this.emit('exit', { code: 0, signal: null, expected: true })
    return Promise.resolve()
  }
}

type Groups = { killAll: () => void; remaining: (ms: number) => Promise<number[]> }

/** One process group that goes only once it is killed, or never. */
function stubbornGroup(options: { dies?: boolean } = {}) {
  let killed = false
  return {
    killAll: vi.fn(() => {
      if (options.dies !== false) killed = true
    }),
    remaining: vi.fn(async (ms: number) => {
      const until = Date.now() + ms
      while (!killed && Date.now() < until) await sleep(5)
      return killed ? [] : [4242]
    }),
  }
}

function host(
  clients: Record<string, FakeClient>,
  options: { disposeFails?: string; groups?: Groups } = {},
) {
  const sessions = new Map(Object.entries(clients))
  const registry = {
    list: () => [...sessions.keys()].map((sessionId) => ({ sessionId, workspacePath: '/repo' })),
    get: (id: string) => {
      const client = sessions.get(id)
      return client && ({ sessionId: id, workspacePath: '/repo', client } as never)
    },
    dispose: vi.fn(async (id: string) => {
      if (id === options.disposeFails) throw new Error('cannot stop')
      sessions.delete(id)
    }),
  }
  const groups = options.groups ?? {
    killAll: vi.fn(),
    remaining: vi.fn(async (): Promise<number[]> => []),
  }
  const life = createLifecycle(() => {})
  life.to('validating')
  life.to('ready')
  const drain = (timings: DrainTimings = FAST) =>
    createDrain({ life, registry, groups, log: () => {}, timings })
  return { life, registry, groups, drain, sessions }
}

describe('the Host lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('moves only forward, and admits a session only when ready', () => {
    const states: HostState[] = []
    const life = createLifecycle((_scope, _message, data) => states.push((data as never)['to']))
    expect(() => life.assertReady()).toThrow('the Host is booting: it takes no new work')
    expect(() => life.to('ready')).toThrow('the Host cannot go from booting to ready')
    life.to('validating')
    life.to('ready')
    expect(() => life.assertReady()).not.toThrow()
    expect(life.isDraining()).toBe(false)
    life.to('draining')
    expect(life.isDraining()).toBe(true)
    expect(() => life.assertReady()).toThrow('the Host is draining')
    life.to('stopped')
    expect(() => life.to('draining')).toThrow('the Host cannot go from stopped to draining')
    expect(states).toEqual(['validating', 'ready', 'draining', 'stopped'])
  })

  it('aborts a turn in flight before stopping it, and stops an idle session at once', async () => {
    const idle = new FakeClient()
    const busy = new FakeClient({ streaming: true, endsOnAbort: true })
    const { drain, registry, life } = host({ idle, busy })
    const result = drain()('finished')
    await vi.advanceTimersByTimeAsync(5)
    expect(await result).toEqual({
      state: 'stopped',
      reason: 'finished',
      sessions: 2,
      aborted: 1,
      unfinished: 0,
      forced: null,
      remaining: [],
      errors: [],
    })
    expect(idle.calls).toEqual(['get_state', 'dispose 50'])
    expect(busy.calls).toEqual(['get_state', 'abort', 'dispose 50'])
    expect(registry.dispose.mock.calls).toEqual([['idle'], ['busy']])
    expect(life.state()).toBe('stopped')
  })

  it("sends no abort when the turn ends before pi's state arrives", async () => {
    const client = new FakeClient({ streaming: true, endsBeforeState: true })
    expect(await host({ client }).drain()('finished')).toMatchObject({ aborted: 0 })
    expect(client.calls).toEqual(['get_state', 'dispose 50'])
  })

  it('counts a turn that does not end in time, and stops it anyway', async () => {
    const client = new FakeClient({ streaming: true })
    const result = host({ client }).drain()('finished')
    const completed = vi.fn()
    void result.then(completed)
    await vi.advanceTimersByTimeAsync(FAST.abortMs - 1)
    expect(completed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ state: 'stopped', aborted: 0, unfinished: 1 })
    expect(client.calls).toEqual(['get_state', 'abort', 'dispose 50'])
  })

  it('fails on a cleanup error, and still stops every other session', async () => {
    const { drain, sessions, life } = host(
      { a: new FakeClient(), b: new FakeClient() },
      { disposeFails: 'b' },
    )
    expect(await drain()('finished')).toMatchObject({ state: 'failed', errors: ['b: cannot stop'] })
    expect([...sessions.keys()]).toEqual(['b'])
    expect(life.state()).toBe('failed')
  })

  it('kills every group and fails once the deadline passes', async () => {
    const { drain, groups } = host({ stuck: new FakeClient({ disposeHangs: true }) })
    const pending = drain({ ...FAST, deadlineMs: 100 })('SIGTERM')
    await vi.advanceTimersByTimeAsync(99)
    expect(groups.killAll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(groups.killAll).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(FAST.settleMs)
    const result = await pending
    expect(result).toMatchObject({ state: 'failed', forced: 'deadline' })
    expect(result).toMatchObject({ reason: 'SIGTERM', sessions: 1, remaining: [], errors: [] })
    expect(groups.killAll).toHaveBeenCalledOnce()
  })

  it('kills at once on a second request, and both requests get the one result', async () => {
    const { drain, groups } = host({ stuck: new FakeClient({ disposeHangs: true }) })
    const run = drain({ ...FAST, deadlineMs: 60_000 })
    const first = run('SIGTERM')
    const second = run('SIGINT')
    expect(second).toBe(first)
    expect(groups.killAll).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(FAST.settleMs)
    expect(await first).toMatchObject({ state: 'stopped', reason: 'SIGTERM', forced: 'hurried' })
    expect(groups.remaining).toHaveBeenCalledOnce()
    expect(groups.killAll).toHaveBeenCalledOnce()
    expect(run('again')).toBe(first)
  })

  it('keeps the deadline through the final check, and kills a group that outlasts it', async () => {
    const groups = stubbornGroup()
    const { drain } = host({ a: new FakeClient() }, { groups })
    const result = drain({ ...FAST, deadlineMs: 100, settleMs: 5000 })('finished')
    await vi.advanceTimersByTimeAsync(99)
    expect(groups.remaining).toHaveBeenCalledOnce()
    expect(groups.killAll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ state: 'failed', forced: 'deadline', remaining: [] })
    expect(groups.killAll).toHaveBeenCalledOnce()
  })

  it('kills at once on a second request during the final check', async () => {
    const groups = stubbornGroup()
    const { drain } = host({ a: new FakeClient() }, { groups })
    const run = drain({ ...FAST, deadlineMs: 60_000, settleMs: 5000 })
    const first = run('finished')
    // The session is stopped; the final check waits on its group.
    await vi.advanceTimersByTimeAsync(0)
    expect(groups.remaining).toHaveBeenCalledOnce()
    expect(run('SIGINT')).toBe(first)
    expect(groups.killAll).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5)
    expect(await first).toMatchObject({ state: 'stopped', forced: 'hurried', remaining: [] })
    expect(groups.killAll).toHaveBeenCalledOnce()
  })

  it('still fails when the deadline passes after a second request', async () => {
    const groups = stubbornGroup({ dies: false })
    const { drain } = host({ stuck: new FakeClient({ disposeHangs: true }) }, { groups })
    const run = drain({ ...FAST, deadlineMs: 200, settleMs: 1000 })
    const first = run('SIGTERM')
    await vi.advanceTimersByTimeAsync(20)
    expect(run('SIGINT')).toBe(first)
    expect(groups.killAll).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toMatchObject({ state: 'failed', forced: 'deadline', remaining: [4242] })
    // Once for the second request, once more at the deadline.
    expect(groups.killAll).toHaveBeenCalledTimes(2)
  })

  it('returns within the deadline and one settle window, however a stop hangs', async () => {
    const groups = stubbornGroup({ dies: false })
    const { drain } = host({ stuck: new FakeClient({ disposeHangs: true }) }, { groups })
    const result = drain({ ...FAST, deadlineMs: 100, settleMs: 1000 })('SIGTERM')
    const completed = vi.fn()
    void result.then(completed)
    await vi.advanceTimersByTimeAsync(100)
    expect(groups.killAll).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(999)
    expect(completed).not.toHaveBeenCalled()
    expect(groups.remaining).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(completed).toHaveBeenCalledOnce()
    expect(await result).toMatchObject({ state: 'failed', forced: 'deadline', remaining: [4242] })
    // The hung stop used the only settle window; the final check gets no extra time.
    expect(groups.remaining).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('fails when a process group outlives the drain', async () => {
    const groups = { killAll: vi.fn(), remaining: vi.fn(async () => [4242]) }
    const { drain } = host({ a: new FakeClient() }, { groups })
    expect(await drain()('finished')).toMatchObject({ state: 'failed', remaining: [4242] })
  })

  it('drains a Host that never became ready', async () => {
    const life = createLifecycle(() => {})
    life.to('validating')
    const registry = { list: () => [], get: () => undefined, dispose: async () => {} }
    const groups = { killAll: () => {}, remaining: async () => [] }
    const drain = createDrain({ life, registry, groups, log: () => {}, timings: FAST })
    expect(await drain('SIGINT')).toMatchObject({ state: 'stopped', sessions: 0 })
  })
})

describe('process groups', () => {
  const started: number[] = []
  afterEach(() => {
    for (const pgid of started.splice(0)) {
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {
        // Gone.
      }
    }
  })
  /** Startup is parent-gated; the leader exits only once its member reports readiness. */
  function group(): ChildProcess {
    const member = `process.on('SIGTERM', () => {}); process.send('member-ready'); setInterval(() => {}, 1000)`
    const script = `
      process.on('message', (message) => {
        if (message === 'start-member') {
          const member = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(member)}], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc']
          });
          member.once('message', (ready) => process.send(ready, () => process.exit(0)));
        }
      });
      process.send('leader-ready');
    `
    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    if (child.pid !== undefined) started.push(child.pid)
    return child
  }
  async function ready(child: ChildProcess, message: string) {
    expect(await once(child, 'message', { signal: AbortSignal.timeout(5000) })).toEqual([
      message,
      undefined,
    ])
  }
  async function startMember(child: ChildProcess) {
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) })
    const memberReady = ready(child, 'member-ready')
    child.send('start-member')
    // Await both even if one fails, so no bounded event wait rejects unobserved.
    const [exit] = await Promise.all([exited, memberReady])
    expect(exit).toEqual([0, null])
  }
  async function until(check: () => boolean) {
    for (let i = 0; i < 250 && !check(); i++) await sleep(20)
    return check()
  }

  it("tracks a group past pi's exit until its last member is gone", async () => {
    const registry = new EventEmitter()
    const groups = trackProcessGroups(registry as never)
    const child = group()
    const pgid = child.pid!
    const client = Object.assign(new EventEmitter(), { pid: pgid })
    child.once('exit', (code, signal) => client.emit('exit', { code, signal, expected: false }))
    registry.emit('created', { client })
    await ready(child, 'leader-ready')
    await startMember(child)
    // The observed leader exit leaves its ready member keeping the group alive.
    expect(await groups.remaining(100)).toEqual([pgid])
    expect(isGone(pgid)).toBe(false)
    expect(groups.live()).toEqual([pgid])
    groups.killAll()
    expect(await until(() => groups.live().length === 0)).toBe(true)
    expect(isGone(pgid)).toBe(true)
    expect(groups.live()).toEqual([])
  }, 15_000)

  it('waits for a late member to be ready before observing the registry client exit', async () => {
    const registry = new EventEmitter()
    const groups = trackProcessGroups(registry as never)
    const child = group()
    const pgid = child.pid!
    const client = Object.assign(new EventEmitter(), { pid: pgid })
    const observed: unknown[] = []
    child.on('message', (message) => observed.push(message))
    const onExit = vi.fn(() => observed.push('exit'))
    client.on('exit', onExit)
    child.once('exit', (code, signal) => client.emit('exit', { code, signal, expected: false }))
    registry.emit('created', { client })
    await ready(child, 'leader-ready')
    // Startup is deliberately withheld until the test releases it, not for a fixed delay.
    expect(onExit).not.toHaveBeenCalled()
    await startMember(child)
    expect(observed).toEqual(['leader-ready', 'member-ready', 'exit'])
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ code: 0, signal: null, expected: false })
    expect(groups.live()).toEqual([pgid])
    expect(isGone(pgid)).toBe(false)
    groups.killAll()
    expect(await groups.remaining(5000)).toEqual([])
  }, 15_000)

  it('never tracks a number that, as a group, would name more than one', () => {
    const registry = new EventEmitter()
    const groups = trackProcessGroups(registry as never)
    // Read only: this test must never signal what it registers.
    for (const pid of [0, 1]) {
      registry.emit('created', { client: Object.assign(new EventEmitter(), { pid }) })
    }
    expect(groups.live()).toEqual([])
  })

  it('keeps a running group until it is killed', async () => {
    const registry = new EventEmitter()
    const groups = trackProcessGroups(registry as never)
    const child = group()
    const pgid = child.pid!
    registry.emit('created', { client: Object.assign(new EventEmitter(), { pid: pgid }) })
    registry.emit('created', { client: Object.assign(new EventEmitter(), { pid: undefined }) })
    await ready(child, 'leader-ready')
    expect(groups.live()).toEqual([pgid])
    groups.killAll()
    expect(await groups.remaining(5000)).toEqual([])
  }, 15_000)
})
