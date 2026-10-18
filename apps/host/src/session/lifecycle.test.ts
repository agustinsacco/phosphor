import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDrain,
  createLifecycle,
  isGone,
  trackProcessGroups,
  type DrainTimings,
  type HostState,
} from './lifecycle'

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
    expect(await drain()('finished')).toEqual({
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
    const started = Date.now()
    const result = await host({ client }).drain()('finished')
    expect(result).toMatchObject({ state: 'stopped', aborted: 0, unfinished: 1 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.abortMs - 5)
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
    const started = Date.now()
    const result = await drain({ ...FAST, deadlineMs: 100 })('SIGTERM')
    expect(result).toMatchObject({ state: 'failed', forced: 'deadline' })
    expect(result).toMatchObject({ reason: 'SIGTERM', sessions: 1, remaining: [], errors: [] })
    expect(groups.killAll).toHaveBeenCalledOnce()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('kills at once on a second request, and both requests get the one result', async () => {
    const { drain, groups } = host({ stuck: new FakeClient({ disposeHangs: true }) })
    const run = drain({ ...FAST, deadlineMs: 60_000 })
    const started = Date.now()
    const first = run('SIGTERM')
    const second = run('SIGINT')
    expect(second).toBe(first)
    expect(await first).toMatchObject({ state: 'stopped', reason: 'SIGTERM', forced: 'hurried' })
    expect(groups.remaining).toHaveBeenCalledOnce()
    expect(groups.killAll).toHaveBeenCalledOnce()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(run('again')).toBe(first)
  })

  it('keeps the deadline through the final check, and kills a group that outlasts it', async () => {
    const groups = stubbornGroup()
    const { drain } = host({ a: new FakeClient() }, { groups })
    const started = Date.now()
    const result = await drain({ ...FAST, deadlineMs: 100, settleMs: 5000 })('finished')
    expect(result).toMatchObject({ state: 'failed', forced: 'deadline', remaining: [] })
    expect(groups.killAll).toHaveBeenCalledOnce()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('kills at once on a second request during the final check', async () => {
    const groups = stubbornGroup()
    const { drain } = host({ a: new FakeClient() }, { groups })
    const run = drain({ ...FAST, deadlineMs: 60_000, settleMs: 5000 })
    const first = run('finished')
    // The session is stopped; the final check waits on its group.
    await vi.waitFor(() => expect(groups.remaining).toHaveBeenCalledOnce())
    const hurried = Date.now()
    expect(run('SIGINT')).toBe(first)
    expect(await first).toMatchObject({ state: 'stopped', forced: 'hurried', remaining: [] })
    expect(groups.killAll).toHaveBeenCalledOnce()
    expect(Date.now() - hurried).toBeLessThan(1000)
  })

  it('still fails when the deadline passes after a second request', async () => {
    const groups = stubbornGroup({ dies: false })
    const { drain } = host({ stuck: new FakeClient({ disposeHangs: true }) }, { groups })
    const run = drain({ ...FAST, deadlineMs: 200, settleMs: 1000 })
    const first = run('SIGTERM')
    await sleep(20)
    expect(run('SIGINT')).toBe(first)
    expect(await first).toMatchObject({ state: 'failed', forced: 'deadline', remaining: [4242] })
    // Once for the second request, once more at the deadline.
    expect(groups.killAll).toHaveBeenCalledTimes(2)
  })

  it('returns within the deadline and one settle window, however a stop hangs', async () => {
    const groups = stubbornGroup({ dies: false })
    const { drain } = host({ stuck: new FakeClient({ disposeHangs: true }) }, { groups })
    const started = Date.now()
    const result = await drain({ ...FAST, deadlineMs: 100, settleMs: 1000 })('SIGTERM')
    expect(result).toMatchObject({ state: 'failed', forced: 'deadline', remaining: [4242] })
    // One window shared by the stop and the check: about 1.1 s. One each takes 2.1 s at least.
    expect(Date.now() - started).toBeLessThan(2000)
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
  /** A group whose leader may exit at once, leaving a member that ignores SIGTERM. */
  function group(leaderExits: boolean): number {
    const member = `require('child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })`
    const script = leaderExits ? `${member}; process.exit(0)` : 'setInterval(() => {}, 1000)'
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
    started.push(child.pid!)
    return child.pid!
  }
  async function until(check: () => boolean) {
    for (let i = 0; i < 250 && !check(); i++) await sleep(20)
    return check()
  }

  it("tracks a group past pi's exit until its last member is gone", async () => {
    const registry = new EventEmitter()
    const groups = trackProcessGroups(registry as never)
    const pgid = group(true)
    const client = Object.assign(new EventEmitter(), { pid: pgid })
    registry.emit('created', { client })
    // The leader is gone; its member keeps the group, and the number, alive.
    await sleep(300)
    client.emit('exit', { code: 0, signal: null, expected: false })
    expect(await groups.remaining(100)).toEqual([pgid])
    expect(isGone(pgid)).toBe(false)
    expect(groups.live()).toEqual([pgid])
    groups.killAll()
    expect(await until(() => groups.live().length === 0)).toBe(true)
    expect(isGone(pgid)).toBe(true)
    expect(groups.live()).toEqual([])
  })

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
    const pgid = group(false)
    registry.emit('created', { client: Object.assign(new EventEmitter(), { pid: pgid }) })
    registry.emit('created', { client: Object.assign(new EventEmitter(), { pid: undefined }) })
    expect(groups.live()).toEqual([pgid])
    groups.killAll()
    expect(await groups.remaining(5000)).toEqual([])
  })
})
