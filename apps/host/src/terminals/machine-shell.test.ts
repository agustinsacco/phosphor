import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TERMINAL_LIMITS as L } from '@phosphor/shared/host-protocol-terminals'
import { createTerminalState } from './service-state'
import { input, terminalFeature } from './operations'
import { machineOp } from './login-runner'
import { reap } from './lifecycle'
import { subscribe } from './subscriptions'

const creator = randomUUID()
const phone = randomUUID()
function setup() {
  let exit = (_: { exitCode: number }) => {}
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: () => ({ dispose() {} }),
    onExit(cb: typeof exit) {
      exit = cb
      return { dispose() {} }
    },
  }
  const spawn = vi.fn(() => pty)
  const save = vi.fn()
  const state = createTerminalState({
    native: { spawn },
    context: {
      // No lane exists: a machine shell must never consult the lane store.
      store: { getLane: () => null, listRepositories: () => [] },
      env: {},
      home: '/',
      log() {},
    },
    env: { HOST_ONLY: 'yes' },
    epoch: 'a'.repeat(16),
    shell: () => '/bin/zsh',
    home: () => '/home/bee',
    load: () => [],
    save,
  })
  const create = (owner = randomUUID()) =>
    machineOp(state, owner, { type: 'terminal.create', cols: 80, rows: 24 }) as {
      terminalId: string
    }
  return { state, pty, spawn, save, create, exit: (code: number) => exit({ exitCode: code }) }
}

describe('machine shells', () => {
  it('spawns the login shell in the Host home without a lane and never persists it', () => {
    const f = setup()
    const { terminalId } = f.create()
    expect(f.spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], {
      cwd: '/home/bee',
      cols: 80,
      rows: 24,
      name: 'xterm-256color',
      env: { HOST_ONLY: 'yes', TERM: 'xterm-256color' },
    })
    expect(f.state.entries.get(terminalId)).toMatchObject({ laneId: '', machine: true })
    expect(f.save).toHaveBeenLastCalledWith([])
    // A lane-scoped reap must not take a shell that has no lane.
    reap(f.state)
    expect(f.state.entries.has(terminalId)).toBe(true)
  })

  it('lets any client with control type, and refuses out-of-order input', () => {
    const f = setup()
    const { terminalId } = f.create(creator)
    expect(
      input(f.state, randomUUID(), { type: 'terminal.input', terminalId, seq: 1, data: 'ls\r' }),
    ).toBe(true)
    expect(input(f.state, creator, { type: 'terminal.input', terminalId, seq: 1, data: 'x' })).toBe(
      false,
    )
    expect(input(f.state, creator, { type: 'terminal.input', terminalId, seq: 2, data: 'x' })).toBe(
      true,
    )
    expect(f.pty.write.mock.calls).toEqual([['ls\r'], ['x']])
  })

  it('is watched, resized and killed from any client', () => {
    const f = setup()
    const { terminalId } = f.create(creator)
    const frames: unknown[] = []
    const off = subscribe(
      f.state,
      () => {},
      { type: 'subscribe', topic: 'terminal', id: 'w', terminalId },
      (frame) => frames.push(frame),
      randomUUID(),
    )
    expect(off).toBeTypeOf('function')
    expect(frames).toEqual([expect.objectContaining({ type: 'terminal.reset', status: 'running' })])
    machineOp(f.state, phone, { type: 'terminal.resize', terminalId, cols: 40, rows: 20 })
    expect(f.pty.resize).toHaveBeenCalledWith(40, 20)
    machineOp(f.state, phone, { type: 'terminal.kill', terminalId })
    expect(f.state.entries.size).toBe(0)
    expect(f.pty.kill).toHaveBeenCalledOnce()
  })

  it('lists only machine shells for an empty scope, and caps them like a lane', async () => {
    const f = setup()
    const feature = terminalFeature(f.state)
    for (let n = 0; n < L.perLane; n++) f.create()
    expect(() => f.create()).toThrow('too-many-requests')
    const listed = await feature.call('terminal.list', {}, {} as never)
    expect(listed).toMatchObject({ ok: true })
    expect((listed as { data: unknown[] }).data).toHaveLength(L.perLane)
    expect((listed as { data: { laneId: string }[] }).data.every((t) => t.laneId === '')).toBe(true)
  })

  it('refuses a relative or unsafe home and reports a shell exit', () => {
    const f = setup()
    f.state.options.home = () => 'relative'
    expect(() => f.create()).toThrow('unavailable')
    f.state.options.home = () => '/home/bee'
    const { terminalId } = f.create()
    f.exit(3)
    expect(f.state.entries.get(terminalId)?.status).toBe('exited')
  })
})
